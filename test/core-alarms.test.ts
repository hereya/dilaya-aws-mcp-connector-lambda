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

  test("each layer that can fail independently has its own alarm", () => {
    const t = template();
    // Lambda: the layer that throws.
    expect(alarmsBy(t, "Errors").length).toBeGreaterThanOrEqual(3);
    expect(alarmsBy(t, "Throttles").length).toBeGreaterThanOrEqual(3);
    // Gateway: the layer that fails WITHOUT the Lambda throwing.
    expect(alarmsBy(t, "5xx")).toHaveLength(1);
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

  // 4xx runs 30–85/day of scanner noise absorbed by tenant apps (all int=200).
  // Alarming it would train everyone to ignore this topic — which is how the
  // alarm layer dies a second time.
  test("4xx is deliberately not alarmed", () => {
    expect(alarmsBy(template(WIRED), "4xx")).toHaveLength(0);
  });
});
