import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The VM denies Data API calls with an invalid HMAC capability token and the
// connector logs "capability rejected: <reason>". The 2026-07-06 bad_signature
// incident took ~21h to surface via the log sweep — this filter+alarm turns any
// recurrence into a CloudWatch signal within minutes. Locked in here: the
// metric filter pattern, the alarm on the Sum over 5 min, and not-breaching on
// missing data (silence is the normal state).
describe("capability-rejected metric filter + alarm", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-alarm-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(): Template {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("creates a metric filter on 'capability rejected' feeding Dilaya/Connector/CapabilityRejected", () => {
    const t = template();
    t.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '"capability rejected"',
      MetricTransformations: [
        Match.objectLike({
          MetricNamespace: "Dilaya/Connector",
          MetricName: "CapabilityRejected",
          MetricValue: "1",
        }),
      ],
    });
  });

  it("alarms on >=1 rejection per 5 min and treats missing data as OK", () => {
    const t = template();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "Dilaya/Connector",
      MetricName: "CapabilityRejected",
      Statistic: "Sum",
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
  });
});
