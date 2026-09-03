import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// Until 2026-08-08 the whole AWS account held FIVE alarms — four on the two
// database VMs, one on capability rejections — so nothing watched Lambda
// errors, gateway 5xx or DynamoDB. Every other instrument was read by hand,
// twice a day: the 10 gateway 5xx of 2026-08-05 and the 17 % CloudFront 5xx on
// *.dilaya-apps.eu each sat through two consecutive "prod entirely clean"
// sweeps.
//
// The lesson that produced this file is that inspecting the alarms you know
// about never asks how many there are. So these tests assert the POPULATION,
// not just that some particular alarm exists.
describe("connector core alarms", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-core-alarms-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(env: Record<string, string> = {}): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
    Object.assign(process.env, env);
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  const WIRED = {
    telegramBotTokenParam: "/dilaya/org/apps/app/telegram/credentials",
    telegramChatId: "8592435915",
  };

  function alarmsBy(t: Template, metricName: string) {
    return Object.values(t.findResources("AWS::CloudWatch::Alarm")).filter(
      (r: any) => r.Properties?.MetricName === metricName
    );
  }

  // The gateway alarm is a metric-math alarm (see the tenant-exclusion tests at
  // the bottom of this file), so it carries `Metrics`, not a `MetricName`.
  function mathAlarms(t: Template) {
    return Object.values(t.findResources("AWS::CloudWatch::Alarm")).filter(
      (r: any) => r.Properties?.Metrics?.some((m: any) => m.Expression)
    );
  }

  function metricFilterFor(t: Template, metricName: string): any {
    const found = Object.values(
      t.findResources("AWS::Logs::MetricFilter")
    ).filter(
      (r: any) =>
        r.Properties?.MetricTransformations?.[0]?.MetricName === metricName
    );
    expect(found).toHaveLength(1);
    return (found[0] as any).Properties;
  }

  test("each layer that can fail independently has its own alarm", () => {
    const t = template();
    // Lambda: the layer that throws.
    expect(alarmsBy(t, "Errors").length).toBeGreaterThanOrEqual(3);
    expect(alarmsBy(t, "Throttles").length).toBeGreaterThanOrEqual(3);
    // Gateway: the layer that fails WITHOUT the Lambda throwing. Still exactly
    // one alarm — but no longer on the raw `AWS/ApiGateway 5xx` metric, which
    // counts every tenant app's own 500s on the shared gateway too.
    expect(mathAlarms(t)).toHaveLength(1);
    expect(alarmsBy(t, "5xx")).toHaveLength(0);
    // DynamoDB: a throttled state write is neither of the above.
    expect(alarmsBy(t, "SystemErrors")).toHaveLength(1);
    expect(alarmsBy(t, "ThrottledRequests")).toHaveLength(1);
    // The one that already existed, still here.
    expect(alarmsBy(t, "CapabilityRejected")).toHaveLength(1);
  });

  test("the main handler is covered, not only the edge lambdas", () => {
    const t = template();
    const t2 = t.findResources("AWS::CloudWatch::Alarm", {
      Properties: { AlarmDescription: "Dilaya connector: Handler Lambda Errors >= 1 in 5 min (baseline is 0)." },
    });
    expect(Object.keys(t2)).toHaveLength(1);
  });

  test("alarms exist even with no Telegram relay configured — they are just silent", () => {
    const t = template();
    t.resourceCountIs("AWS::SNS::Topic", 0);
    const all = Object.values(t.findResources("AWS::CloudWatch::Alarm"));
    expect(all.length).toBeGreaterThan(5);
    for (const alarm of all as any[]) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
    }
  });

  test("with the relay configured, EVERY alarm speaks — none is left mute", () => {
    const t = template(WIRED);
    const all = Object.values(t.findResources("AWS::CloudWatch::Alarm")) as any[];
    expect(all.length).toBeGreaterThan(5);
    // The bug being fixed was a single alarm silently lacking an action. Assert
    // over the whole population so a future alarm added without alertOn() fails
    // here rather than in a sweep six weeks later.
    const mute = all.filter(
      (a) => !a.Properties.AlarmActions?.length || !a.Properties.OKActions?.length
    );
    expect(mute).toHaveLength(0);
  });

  test("no alarm treats missing data as breaching — a quiet function is not a broken one", () => {
    const t = template(WIRED);
    for (const alarm of Object.values(
      t.findResources("AWS::CloudWatch::Alarm")
    ) as any[]) {
      expect(alarm.Properties.TreatMissingData).toBe("notBreaching");
    }
  });

  // --- Whose 5xx is it? (2026-08-20) ------------------------------------
  // Over 30 days and 26 alarms, exactly ONE alarm had ever fired for real:
  // the gateway 5xx one, 4 times on 2026-08-14 — and it was not us. The 10
  // requests behind it all carried `int=200` on `…/komlaba/site-stg/…`: a
  // client's pre-production site answering 500 on two of its own routes. An
  // alarm that cries wolf for someone else's bug is how the only real-time
  // alert this platform has gets ignored.
  //
  // The two patterns below were verified against those very log lines with
  // `aws logs filter-log-events` on the prod access-log group: in the
  // 22:10–22:30Z window the all-5xx pattern matches 8 events and the tenant
  // pattern matches the same 8 — difference 0, alarm silent.
  test("the gateway alarm counts only the 5xx that are ours", () => {
    const alarm = mathAlarms(template(WIRED))[0] as any;
    const expression = alarm.Properties.Metrics.find((m: any) => m.Expression);
    expect(expression.Expression).toBe("total - tenantApp");
    expect(alarm.Properties.Threshold).toBe(1);
  });

  // The trap this test exists to hold shut: excluding on `integrationStatus`
  // ALONE looks like the obvious fix and is a blinding one — our own handler
  // returning a 500 also answers with `int=200`. A 5xx is the client's only
  // when the integration answered AND the route is one of the tenant `/site`
  // routes, which are the only ones wired straight to an `app-app-*` Lambda.
  test("a 5xx counts as the tenant's only on BOTH signals, never on integrationStatus alone", () => {
    const t = template(WIRED);
    expect(metricFilterFor(t, "HttpApi5xx").FilterPattern).toBe(
      '{ $.status = "5*" }'
    );
    expect(metricFilterFor(t, "HttpApi5xxTenantApp").FilterPattern).toBe(
      '{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }'
    );
  });

  // Access-log values are JSON strings, so these are wildcard string matches.
  // A numeric comparison (`$.status >= 500`) reads as a type mismatch and
  // matches nothing — a permanently silent alarm that looks perfectly healthy.
  test("the 5xx patterns match strings, the way the access log actually writes them", () => {
    for (const name of ["HttpApi5xx", "HttpApi5xxTenantApp"]) {
      expect(metricFilterFor(template(WIRED), name).FilterPattern).toContain(
        '$.status = "5*"'
      );
    }
  });

  // Without a default value, a period with no match produces NO datapoint, and
  // `total - tenantApp` is then dropped for that period instead of evaluating
  // — silently disarming the alarm in the exact case it exists for: a platform
  // 5xx during a period with no tenant 5xx.
  test("both 5xx filters emit 0 when they do not match, so the subtraction always evaluates", () => {
    const t = template(WIRED);
    for (const name of ["HttpApi5xx", "HttpApi5xxTenantApp"]) {
      expect(
        metricFilterFor(t, name).MetricTransformations[0].DefaultValue
      ).toBe(0);
    }
  });

  // 4xx runs 30–85/day of scanner noise absorbed by tenant apps (all int=200).
  // Alarming it would train everyone to ignore this topic — which is how the
  // alarm layer dies a second time.
  test("4xx is deliberately not alarmed", () => {
    expect(alarmsBy(template(WIRED), "4xx")).toHaveLength(0);
  });

  // --- Volume (2026-08-27) ----------------------------------------------
  // Every alarm above counts FAILURES, and on 2026-08-27 that turned out to
  // be one shared blind spot rather than several: a single browser called one
  // tenant route 17 386 times in under two hours (10-19 req/s, sustained,
  // ~70 % of the day's connector traffic) and EVERY request answered 200.
  // Lambda Errors 0, gateway 5xx 0, CloudFront 5xxErrorRate 0 %, VM heartbeat
  // 60/60 — all 32 alarms in the account structurally silent, because not one
  // of them looks at a volume. The only witness was the invocation count,
  // which nobody reads between two sweeps.
  test("something watches VOLUME, not only failure", () => {
    expect(alarmsBy(template(WIRED), "Invocations")).toHaveLength(1);
  });

  // The frontend authorizer is the one place that sees every tenant site/auth
  // request (authorizerResultTtlInSeconds: 0 — no caching, so one invocation
  // per request), and that traffic is the only UNBOUNDED population here:
  // it is public browser traffic. The rest is agents and crons, whose rate we
  // set ourselves.
  test("the volume alarm watches the path that public browsers can flood", () => {
    const alarm = alarmsBy(template(WIRED), "Invocations")[0] as any;
    const fnDim = alarm.Properties.Dimensions.find(
      (d: any) => d.Name === "FunctionName"
    );
    expect(JSON.stringify(fnDim.Value)).toContain("FrontendAuthorizer");
  });

  // Calibrated the opposite way round from the failure alarms: those sit just
  // above an empirically zero floor, this one must sit far enough above a
  // BUSY baseline to never cry wolf. Background 2-190/h, the incident ~36 000/h
  // — 3 000/h is ~16x the busiest legitimate hour ever measured and ~1/12th of
  // the loop. An hourly period is deliberate too: this asks "is someone
  // burning money right now?", which does not get a better answer for being
  // asked every five minutes, and a 5-minute window at the same rate would
  // fire on legitimate short bursts.
  test("the volume threshold clears real traffic by a wide margin", () => {
    const alarm = alarmsBy(template(WIRED), "Invocations")[0] as any;
    expect(alarm.Properties.Threshold).toBe(3000);
    expect(alarm.Properties.Period).toBe(3600);
    expect(alarm.Properties.Statistic).toBe("Sum");
    expect(alarm.Properties.EvaluationPeriods).toBe(1);
  });

  // --- The customer's half: an app's own 5xx is routed to THAT org ------------
  // Until 2026-09-03 the tenant-5xx population was counted and told to nobody:
  // the platform alarm subtracts it on purpose, and no alarm read the remainder.
  // This one exists to ROUTE it through the relay to the connector's analyser.
  test("an app's own 5xx has an alarm of its own, wired to the relay like the others", () => {
    const t = template(WIRED);
    const alarms = alarmsBy(t, "HttpApi5xxTenantApp") as any[];
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0];
    expect(alarm.Properties.Namespace).toBe("Dilaya/Connector");
    expect(alarm.Properties.Threshold).toBe(3);
    expect(alarm.Properties.Period).toBe(300);
    expect(alarm.Properties.Statistic).toBe("Sum");
    expect(alarm.Properties.TreatMissingData).toBe("notBreaching");
    expect(alarm.Properties.AlarmActions).toHaveLength(1);
    expect(alarm.Properties.OKActions).toHaveLength(1);
    expect(alarm.Properties.AlarmDescription).toContain("NOT a platform fault");
  });

  // The analyser reads the access log through Logs Insights. Without the group
  // name the connector skips the analysis in silence ("no_access_log_group"),
  // and without StartQuery it fails it — both are the same customer left
  // uninformed, so both halves are pinned here.
  test("the handler knows the access-log group and may query it — nothing else", () => {
    const t = template(WIRED);
    const fns = Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) =>
      id.startsWith("Handler")
    );
    expect(fns).toHaveLength(1);
    const env = (fns[0]![1] as any).Properties.Environment.Variables;
    expect(env.ACCESS_LOG_GROUP).toBeDefined();
    expect(JSON.stringify(env.ACCESS_LOG_GROUP)).toContain("HttpApiAccessLogs");

    const statements = Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
      (r: any) => r.Properties.PolicyDocument.Statement as any[]
    );
    const start = statements.find((st) => JSON.stringify(st.Action).includes("logs:StartQuery"));
    expect(start).toBeDefined();
    expect(JSON.stringify(start.Resource)).toContain("HttpApiAccessLogs");
    expect(JSON.stringify(start.Action)).not.toContain("logs:PutLogEvents");
    const results = statements.find((st) => JSON.stringify(st.Action).includes("logs:GetQueryResults"));
    expect(results).toBeDefined();
    expect(results.Action).toEqual("logs:GetQueryResults");
  });

  // --- The rate guard's only witness -------------------------------------
  // The guard ships in COUNT mode: it refuses nothing and logs one line per
  // offending request. So this filter is the ONLY evidence it does anything at
  // all. A component that RUNS without DELIVERING is invisible to every
  // instrument that counts executions — which is how the alarm relay sat broken
  // through two real firings (t_e95d603a0a32).
  test("what the rate guard would have refused is counted, not just logged", () => {
    const t = template(WIRED);
    expect(metricFilterFor(t, "RateGuardTripped").FilterPattern).toBe(
      '{ $.type = "rate_guard" }'
    );
    expect(alarmsBy(t, "RateGuardTripped")).toHaveLength(1);
  });

  // CloudWatch refuses a metric filter carrying BOTH dimensions and a
  // defaultValue, and refuses dimensions at all on a pattern that extracts no
  // named fields. Neither rule is enforced by `cdk synth` — both cost a
  // rolled-back production deploy on 2026-08-27.
  test("the rate-guard filter carries no dimensions CloudWatch would refuse", () => {
    const tr = metricFilterFor(template(WIRED), "RateGuardTripped")
      .MetricTransformations[0];
    expect(tr.Dimensions).toBeUndefined();
    expect(tr.MetricValue).toBe("1");
  });
});

// The counter that alarm exists beside writes to APP_STATE_TABLE from the most
// exposed Lambda in the stack — the one every anonymous request reaches. The
// same table holds per-app agent-session secrets, the quota measurement cache
// and the LLM spend ledger, so the grant must stay pinned to the counter rows.
describe("frontend authorizer table grant", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-authz-grant-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function policies(): any[] {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "GrantStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const t = Template.fromStack(stack);
    // The authorizer's own inline policy, found by the statement only it has.
    return Object.values(t.findResources("AWS::IAM::Policy"))
      .map((r: any) => r.Properties.PolicyDocument.Statement)
      .filter((sts: any[]) =>
        sts.some(
          (st) =>
            JSON.stringify(st.Condition ?? "").includes("reqcount#") ||
            false
        )
      );
  }

  test("the counter grant is pinned to the counter rows", () => {
    const found = policies();
    expect(found).toHaveLength(1);
    const st = found[0].find((s: any) =>
      JSON.stringify(s.Condition ?? "").includes("reqcount#")
    );
    expect(st.Action).toBe("dynamodb:UpdateItem");
    // Three counter families, and nothing else on this table: the per-app
    // monthly count, the per-IP-per-minute rate guard, and the per-ORG monthly
    // count the plan's request cap is enforced against.
    expect(
      st.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
    ).toEqual(["reqcount#*", "ratecount#*", "reqcountorg#*"]);
  });

  // grantReadWriteData would have been one word shorter and would have put the
  // session secrets, the quota cache and the spend ledger inside the blast
  // radius of the Lambda every stranger on the internet can reach.
  test("adding a counter did not hand the authorizer the whole table", () => {
    const st = policies()[0];
    const writes = st.filter((s: any) => {
      const actions = ([] as string[]).concat(s.Action ?? []);
      return actions.some((a) =>
        ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:*"].includes(a)
      );
    });
    expect(writes).toHaveLength(0);
    // ...and the one Update it does have is conditioned, never bare.
    for (const s of st) {
      const actions = ([] as string[]).concat(s.Action ?? []);
      if (actions.includes("dynamodb:UpdateItem")) {
        expect(s.Condition).toBeDefined();
      }
    }
  });
});

// The last-resort ceiling under the per-IP guard (t_09669ba18d5e). The two are
// not interchangeable: the authorizer's guard cuts the one address that is
// looping, this one is global and would throttle every tenant — and `/mcp`
// with them. It exists for what the targeted guard cannot see, and it is the
// only layer that can answer a real 429 (an authorizer refusal is always 403).
describe("gateway last-resort throttle", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-throttle-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function stage(): any {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "ThrottleStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const stages = Template.fromStack(stack).findResources("AWS::ApiGatewayV2::Stage");
    return (Object.values(stages)[0] as any).Properties;
  }

  test("the gateway has a ceiling at all", () => {
    const rs = stage().DefaultRouteSettings;
    expect(rs.ThrottlingRateLimit).toBe(100);
    expect(rs.ThrottlingBurstLimit).toBe(200);
  });

  // The number is deliberately absurd rather than tuned. Real traffic is
  // 500-2300 requests per DAY (~0.03/s) and the 2026-08-27 runaway peaked at
  // 19/s. A ceiling anywhere near real traffic would make one tenant's loop
  // everyone's outage — including the agents on /mcp.
  test("the ceiling leaves room for many times the worst second ever recorded", () => {
    const observedWorstRps = 20;
    expect(stage().DefaultRouteSettings.ThrottlingRateLimit).toBeGreaterThanOrEqual(
      observedWorstRps * 5
    );
  });

  // Adding throttling must not silently drop the per-route metrics that make a
  // 5xx attributable — they live in the same property. Since 2026-08-29 those
  // metrics live on the platform routes' own settings (the stage default is
  // off, so runtime-created tenant routes stop billing six custom metrics
  // each); this asserts the throttle did not take them down with it.
  test("per-route metrics survive the addition", () => {
    const settings = Object.values(stage().RouteSettings) as any[];
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((s) => s.DetailedMetricsEnabled === true)).toBe(true);
  });

  // The ceiling has to hold on the platform routes too, and they no longer
  // inherit it — they carry their own copy.
  test("every platform route carries the same ceiling as the default", () => {
    const props = stage();
    for (const setting of Object.values(props.RouteSettings) as any[]) {
      expect(setting.ThrottlingRateLimit).toBe(
        props.DefaultRouteSettings.ThrottlingRateLimit
      );
    }
  });
});

// The gap that let a green deploy ship a guard that refused nothing.
//
// The authorizer's own default was flipped to enforcing, but the STACK kept
// stamping FRONTEND_RATE_BLOCK="false" onto the function — and an explicit env
// var beats a code default, so the deploy went green while the guard stayed
// inert. Nothing in the suite noticed, because every test asserted the
// authorizer's behaviour with env vars it set ITSELF; none asserted what the
// stack actually SENDS. It was caught by reading the deployed function's
// configuration in production.
//
// So this asserts the wiring, not the behaviour: what value leaves the stack.
describe("rate guard wiring (what the stack actually sends)", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-rate-env-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function authorizerEnv(env: Record<string, string> = {}): any {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    Object.assign(process.env, env);
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "RateEnvStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const fns = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    const authorizer = Object.values(fns).find((f: any) =>
      JSON.stringify(f.Properties?.Environment?.Variables ?? {}).includes(
        "FRONTEND_RATE_LIMIT"
      )
    ) as any;
    return authorizer.Properties.Environment.Variables;
  }

  test("the deployed authorizer is told to ENFORCE, not merely allowed to", () => {
    expect(authorizerEnv().FRONTEND_RATE_BLOCK).toBe("true");
    expect(authorizerEnv().FRONTEND_RATE_LIMIT).toBe("1000");
  });

  test("and the off switch still reaches it", () => {
    expect(authorizerEnv({ frontendRateBlock: "false" }).FRONTEND_RATE_BLOCK).toBe(
      "false"
    );
  });
});
