import { useStackFixture, WIRED } from "../core-alarms/helpers";
import { BRIDGE_NAMESPACE } from "../../lib/stack/region-router/metrics-bridge";
import { ROUTER_ENV } from "./helpers";

// t_rca_router_alarm (29/10/2026): after the 27/10 cutover every call crosses the router, and the
// 27/10 incident (503 FunctionExecutionError before any pod) was invisible to every pod alarm.
const res = (t: any, type: string): any[] => Object.values(t.findResources(type));
const routerAlarms = (t: any) => res(t, "AWS::CloudWatch::Alarm").filter((a) => a.Properties.Namespace === BRIDGE_NAMESPACE);
const bridgeOf = (t: any) =>
  res(t, "AWS::Lambda::Function").find((f) => String(f.Properties.Code?.ZipFile ?? "").includes(BRIDGE_NAMESPACE));

/** The shipped bridge, run with only its SDK stubbed: GetMetricData answers `values`, PutMetricData is recorded. */
function runBridge(code: string, values: Record<string, number[]>) {
  process.env.ROUTER_FUNCTION_NAME = "app-app-region-router";
  process.env.ROUTER_DISTRIBUTION_ID = "E3FNARWEXLBHHX";
  const sent: any[] = [];
  const clients: any[] = [];
  class Cmd {
    constructor(public input: any, public kind: string) {}
  }
  const sdk = {
    CloudWatchClient: class {
      constructor(public cfg: any) {
        clients.push(cfg);
      }
      async send(c: Cmd) {
        sent.push({ region: this.cfg.region, kind: c.kind, input: c.input });
        if (c.kind !== "get") return {};
        return {
          MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({
            Id: q.Id,
            Values: values[q.MetricStat.Metric.MetricName] ?? [],
          })),
        };
      }
    },
    GetMetricDataCommand: class extends Cmd {
      constructor(i: any) {
        super(i, "get");
      }
    },
    PutMetricDataCommand: class extends Cmd {
      constructor(i: any) {
        super(i, "put");
      }
    },
  };
  const mod: any = { exports: {} };
  new Function("require", "module", "exports", code)((n: string) => {
    expect(n).toBe("@aws-sdk/client-cloudwatch");
    return sdk;
  }, mod, mod.exports);
  return { mod: mod.exports, sent, clients };
}

describe("region router: alarms through a metrics bridge", () => {
  const template = useStackFixture("connector-region-alarms-", "RegionAlarms", { clearOptionalEnv: true });

  it("absent router: no bridge, no router alarm", () => {
    const t = template({ ...WIRED, customDomain: "app.dilaya.eu", wildcardCertificateArn: ROUTER_ENV.wildcardCertificateArn });
    expect(bridgeOf(t)).toBeUndefined();
    expect(routerAlarms(t)).toHaveLength(0);
  });

  it("on: function errors, throttles and 5xx rate are alarmed, and every one speaks through the relay", () => {
    const t = template({ ...WIRED, ...ROUTER_ENV });
    const by = Object.fromEntries(routerAlarms(t).map((a) => [a.Properties.MetricName, a.Properties]));
    expect(Object.keys(by).sort()).toEqual(["5xxErrorRate", "FunctionExecutionErrors", "FunctionThrottles"]);
    expect(by.FunctionExecutionErrors).toMatchObject({ Statistic: "Sum", Threshold: 1, Period: 300 });
    expect(by["5xxErrorRate"]).toMatchObject({ Statistic: "Average", Threshold: 5 });
    for (const a of Object.values(by) as any[]) {
      expect(a.TreatMissingData).toBe("notBreaching");
      expect(a.AlarmActions).toHaveLength(1);
      expect(a.OKActions).toHaveLength(1);
    }
    // The bridge going blind is itself an alarm, or the three above stay silent for ever.
    const bridgeErrors = res(t, "AWS::CloudWatch::Alarm").filter(
      (a) => a.Properties.MetricName === "Errors" && JSON.stringify(a.Properties.Dimensions).includes("RegionRouterMetricsBridge")
    );
    expect(bridgeErrors).toHaveLength(1);
    expect(bridgeErrors[0].Properties.AlarmActions).toHaveLength(1);
  });

  it("the bridge writes only its own namespace, ticks every 5 minutes, never retries", () => {
    const t = template({ ...WIRED, ...ROUTER_ENV });
    const stmts = res(t, "AWS::IAM::Policy").flatMap((p) => p.Properties.PolicyDocument.Statement);
    const put = stmts.filter((s) => s.Action === "cloudwatch:PutMetricData");
    expect(put).toHaveLength(1);
    expect(put[0].Condition).toEqual({ StringEquals: { "cloudwatch:namespace": BRIDGE_NAMESPACE } });
    const rule = res(t, "AWS::Events::Rule").find((r) => String(r.Properties.Description).includes("Region router metrics"));
    expect(rule.Properties.ScheduleExpression).toBe("rate(5 minutes)");
    expect(rule.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts).toBe(0);
  });

  it("the shipped bridge reads ONE closed bucket in us-east-1 and republishes it here, stamped now", async () => {
    const t = template({ ...WIRED, ...ROUTER_ENV });
    const { mod, sent, clients } = runBridge(bridgeOf(t).Properties.Code.ZipFile, {
      FunctionExecutionErrors: [3],
      "5xxErrorRate": [12.5],
      FunctionComputeUtilization: [94],
    });
    expect(clients.map((c) => c.region)).toEqual(["us-east-1", undefined]);
    const now = Date.UTC(2026, 9, 29, 8, 7, 30);
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await mod.handler({});
    } finally {
      Date.now = realNow;
    }
    const [get, put] = sent;
    expect(get).toMatchObject({ region: "us-east-1", kind: "get" });
    // 08:07:30 → the bucket 07:55-08:00, closed between 5 and 10 minutes ago.
    expect(get.input.StartTime.toISOString()).toBe("2026-10-29T07:55:00.000Z");
    expect(get.input.EndTime.toISOString()).toBe("2026-10-29T08:00:00.000Z");
    expect(get.input.MetricDataQueries.every((q: any) => q.MetricStat.Period === 300)).toBe(true);
    const fn = get.input.MetricDataQueries.find((q: any) => q.MetricStat.Metric.MetricName === "FunctionExecutionErrors");
    expect(fn.MetricStat.Metric.Dimensions).toEqual(
      expect.arrayContaining([{ Name: "Region", Value: "Global" }, { Name: "FunctionName", Value: "app-app-region-router" }])
    );
    expect(put).toMatchObject({ region: undefined, kind: "put", input: { Namespace: BRIDGE_NAMESPACE } });
    const pub = Object.fromEntries(put.input.MetricData.map((d: any) => [d.MetricName, d]));
    // No datapoint (throttles) → nothing published: missing, not a fabricated zero.
    expect(Object.keys(pub).sort()).toEqual(["5xxErrorRate", "FunctionComputeUtilization", "FunctionExecutionErrors"]);
    expect(pub.FunctionExecutionErrors.Value).toBe(3);
    expect(pub.FunctionExecutionErrors.Timestamp.getTime()).toBe(now);
  });

  it("consecutive runs never read the same bucket twice", async () => {
    const t = template({ ...WIRED, ...ROUTER_ENV });
    const { mod } = runBridge(bridgeOf(t).Properties.Code.ZipFile, {});
    const base = Date.UTC(2026, 9, 29, 8, 0, 1);
    const starts = [0, 1, 2, 3].map((k) => mod.bucketOf(base + k * 300_000 + 7_000).start.getTime());
    expect(new Set(starts).size).toBe(4);
    expect(starts[1] - starts[0]).toBe(300_000);
  });

  it("a quiet bucket publishes nothing at all", async () => {
    const t = template({ ...WIRED, ...ROUTER_ENV });
    const { mod, sent } = runBridge(bridgeOf(t).Properties.Code.ZipFile, {});
    await mod.handler({});
    expect(sent.map((s) => s.kind)).toEqual(["get"]);
  });
});
