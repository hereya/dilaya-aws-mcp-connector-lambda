import { useStackFixture, WIRED } from "./helpers";
import { EDGE_NAMESPACE } from "../../lib/stack/alarms/edge";
import { BRIDGE_NAMESPACE } from "../../lib/stack/region-router/metrics-bridge";

// CloudFront publishes its metrics in us-east-1 only, so no alarm of this stack (pod region) saw
// the edge: a viewer function answering 502 FunctionValidationError to visitors rang nothing.
// The edge alarms copy the metrics here through a bridge (as the region router does) and speak
// through the same relay as every other alarm.

const res = (t: any, type: string): any[] => Object.values(t.findResources(type));
const alarms = (t: any) => res(t, "AWS::CloudWatch::Alarm");
const edgeAlarms = (t: any) =>
  alarms(t).filter((a) => a.Properties.Namespace === EDGE_NAMESPACE || JSON.stringify(a.Properties.Metrics ?? []).includes(EDGE_NAMESPACE));
const bridgeOf = (t: any) =>
  res(t, "AWS::Lambda::Function").find((f) => String(f.Properties.Code?.ZipFile ?? "").includes(EDGE_NAMESPACE));
const topicRef = (t: any) => {
  const ids = Object.keys(t.findResources("AWS::SNS::Topic")).filter((k) => k.startsWith("ConnectorAlertTopic"));
  expect(ids).toHaveLength(1);
  return { Ref: ids[0] };
};

const APP_CONTENT = {
  customDomain: "app.example.com",
  customDomainZone: "example.com",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/mcp",
  appContentDomain: "apps.example.net",
  appContentZoneId: "Z0APPS",
  appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/apps",
};
const FILES = {
  hereyaProjectEnv: JSON.stringify({ bucketName: "example-bucket", s3Prefix: "p-x" }),
  filesDomain: "files.example.com",
  filesZoneId: "Z0FILES",
  filesCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/files",
};

/** The shipped bridge, its SDK stubbed: GetMetricData answers `values` by metric name. */
async function runBridge(code: string, env: Record<string, string>, values: Record<string, number[]>) {
  const sent: any[] = [];
  class Cmd {
    constructor(public input: any, public kind: string) {}
  }
  const sdk = {
    CloudWatchClient: class {
      constructor(public cfg: any) {}
      async send(c: Cmd) {
        sent.push({ region: this.cfg.region, kind: c.kind, input: c.input });
        if (c.kind !== "get") return {};
        return {
          MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({
            Id: q.Id,
            Values: values[q.MetricStat.Metric.MetricName + "@" + q.MetricStat.Metric.Dimensions[0].Value] ?? [],
          })),
        };
      }
    },
    GetMetricDataCommand: class extends Cmd { constructor(i: any) { super(i, "get"); } },
    PutMetricDataCommand: class extends Cmd { constructor(i: any) { super(i, "put"); } },
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod: any = { exports: {} };
    new Function("require", "module", "exports", code)(() => sdk, mod, mod.exports);
    await mod.exports.handler({});
  } finally {
    process.env = saved;
  }
  return sent;
}

describe("edge alarms: CloudFront, through a metrics bridge", () => {
  const template = useStackFixture("connector-edge-alarms-", "EdgeAlarms", { clearOptionalEnv: true });

  it("no distribution, no router: no bridge, no edge alarm", () => {
    const t = template({ ...WIRED });
    expect(bridgeOf(t)).toBeUndefined();
    expect(edgeAlarms(t)).toHaveLength(0);
  });

  it("vanity hosts on: a guarded 5xx alarm on the distribution, two function alarms, all on the relay", () => {
    const t = template({ ...WIRED, ...APP_CONTENT });
    const topic = topicRef(t);
    const found = edgeAlarms(t);
    expect(found).toHaveLength(3);
    for (const a of found) {
      expect(a.Properties.TreatMissingData).toBe("notBreaching");
      expect(a.Properties.Threshold).toBe(1);
      expect(a.Properties.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
      expect(a.Properties.AlarmActions).toEqual([topic]);
      expect(a.Properties.OKActions).toEqual([topic]);
    }
    const fn = found.filter((a) => a.Properties.MetricName).map((a) => [a.Properties.MetricName, a.Properties.Statistic]);
    expect(fn.sort()).toEqual([
      ["AppHostRouterFunctionExecutionErrors", "Sum"],
      ["AppHostRouterFunctionValidationErrors", "Sum"],
    ]);
    const math = found.find((a) => a.Properties.Metrics)!.Properties.Metrics;
    expect(math.find((m: any) => m.Expression).Expression).toBe("IF(rate >= 5 AND req >= 20, 1, 0)");
    const stat = Object.fromEntries(math.filter((m: any) => m.MetricStat).map((m: any) => [m.Id, m.MetricStat]));
    expect(stat.rate).toMatchObject({ Metric: { MetricName: "AppContent5xxErrorRate" }, Stat: "Maximum", Period: 300 });
    expect(stat.req).toMatchObject({ Metric: { MetricName: "AppContentRequests" }, Stat: "Maximum", Period: 300 });
  });

  it("the files distribution gets its own 5xx alarm", () => {
    const t = template({ ...WIRED, ...APP_CONTENT, ...FILES });
    const names = edgeAlarms(t).flatMap((a) => (a.Properties.Metrics ?? []).map((m: any) => m.MetricStat?.Metric.MetricName));
    expect(names.filter(Boolean).sort()).toEqual(["AppContent5xxErrorRate", "AppContentRequests", "Files5xxErrorRate", "FilesRequests"]);
  });

  it("the bridge writes only its own namespace, ticks every 5 minutes, never retries, and is alarmed", () => {
    const t = template({ ...WIRED, ...APP_CONTENT });
    const put = res(t, "AWS::IAM::Policy")
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s) => s.Action === "cloudwatch:PutMetricData");
    expect(put).toHaveLength(1);
    expect(put[0].Condition).toEqual({ StringEquals: { "cloudwatch:namespace": EDGE_NAMESPACE } });
    const rule = res(t, "AWS::Events::Rule").find((r) => String(r.Properties.Description).startsWith("Edge metrics"));
    expect(rule.Properties.ScheduleExpression).toBe("rate(5 minutes)");
    expect(rule.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts).toBe(0);
    const bridgeErrors = alarms(t).filter(
      (a) => a.Properties.MetricName === "Errors" && JSON.stringify(a.Properties.Dimensions).includes("EdgeMetricsBridge")
    );
    expect(bridgeErrors).toHaveLength(1);
    expect(bridgeErrors[0].Properties.AlarmActions).toEqual([topicRef(t)]);
  });

  it("the shipped bridge reads us-east-1 by distribution and function, and republishes under its own names", async () => {
    const t = template({ ...WIRED, ...APP_CONTENT });
    const code = bridgeOf(t).Properties.Code.ZipFile;
    expect(code).not.toContain(BRIDGE_NAMESPACE);
    const env = { APPCONTENT_DISTRIBUTION_ID: "EDFDVBD6EXAMPLE", ROUTER_FUNCTION_NAME: "example-apphost-router" };
    const sent = await runBridge(code, env, {
      "5xxErrorRate@EDFDVBD6EXAMPLE": [12.5],
      "Requests@EDFDVBD6EXAMPLE": [40],
      "FunctionValidationErrors@example-apphost-router": [2],
    });
    const [get, put] = sent;
    expect(get.region).toBe("us-east-1");
    const dims = get.input.MetricDataQueries.map((q: any) => [q.MetricStat.Metric.MetricName, q.MetricStat.Metric.Dimensions]);
    expect(dims).toEqual([
      ["5xxErrorRate", [{ Name: "DistributionId", Value: "EDFDVBD6EXAMPLE" }, { Name: "Region", Value: "Global" }]],
      ["Requests", [{ Name: "DistributionId", Value: "EDFDVBD6EXAMPLE" }, { Name: "Region", Value: "Global" }]],
      ["FunctionExecutionErrors", [{ Name: "FunctionName", Value: "example-apphost-router" }, { Name: "Region", Value: "Global" }]],
      ["FunctionValidationErrors", [{ Name: "FunctionName", Value: "example-apphost-router" }, { Name: "Region", Value: "Global" }]],
    ]);
    expect(put).toMatchObject({ region: undefined, kind: "put", input: { Namespace: EDGE_NAMESPACE } });
    const pub = Object.fromEntries(put.input.MetricData.map((d: any) => [d.MetricName, d.Value]));
    // No execution error in the bucket → nothing published for it (missing, not a fabricated zero).
    expect(pub).toEqual({ AppContent5xxErrorRate: 12.5, AppContentRequests: 40, AppHostRouterFunctionValidationErrors: 2 });
  });

  it("the bridge's environment carries the distribution id and the function name", () => {
    const t = template({ ...WIRED, ...APP_CONTENT });
    const vars = bridgeOf(t).Properties.Environment.Variables;
    expect(Object.keys(vars).sort()).toEqual(["APPCONTENT_DISTRIBUTION_ID", "ROUTER_FUNCTION_NAME"]);
    expect(JSON.stringify(vars.APPCONTENT_DISTRIBUTION_ID)).toContain("AppContentDistribution");
  });
});
