import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The integrated dev agent's worker (lib/stack/dev-agent-worker.ts): fully
// inert by default, and when on, the connector gains exactly one statement.
const PROJECT_ENV = { registryTableName: "registry", dataApiUrl: "https://data.example" };
const SECONDARY = {
  customDomain: "app.example.eu",
  customDomainZone: "example.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  originDomain: "app-ca.example.eu",
  skipGlobalResources: "true",
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-devagent-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>, region = "eu-west-1"): Template {
  process.env = {
    ...saved,
    hereyaProjectRootDir: root,
    oauthServerUrl: "https://example.eu/oauth/connect",
    hereyaProjectEnv: JSON.stringify(PROJECT_ENV),
  };
  delete process.env.devAgentWorker;
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "DevAgentStack", { env: { account: "123456789012", region } });
  return Template.fromStack(stack);
}

const fns = (t: Template): Record<string, any> => t.findResources("AWS::Lambda::Function");
const handlerId = (t: Template): string =>
  Object.entries(fns(t)).find(([, f]) => f.Properties.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS !== undefined)![0];
const workerId = (t: Template): string =>
  Object.entries(fns(t)).find(([, f]) => f.Properties.Handler === "dev-agent-handler.handler")![0];
const roleOf = (t: Template, fnId: string): string => fns(t)[fnId].Properties.Role["Fn::GetAtt"][0];
/** Every statement attached to that role, through any AWS::IAM::Policy. */
const statementsOf = (t: Template, roleId: string): any[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[])
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(`"${roleId}"`))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
const queueId = (t: Template, name: string): string =>
  Object.entries(t.findResources("AWS::SQS::Queue")).find(([, q]: [string, any]) => q.Properties.QueueName === name)![0];
const mentionsSqs = (s: any): boolean => JSON.stringify(s.Action).includes("sqs:");

describe("dev agent worker, off (default)", () => {
  it.each([
    ["absent", {}],
    ["empty", { devAgentWorker: "" }],
    ["false", { devAgentWorker: "false" }],
  ])("%s → no queue, no worker, no mapping, no alarm, no output, nothing on the connector", (_l, env) => {
    const t = synth(env as Record<string, string>);
    t.resourceCountIs("AWS::SQS::Queue", 0);
    t.resourceCountIs("AWS::SQS::QueuePolicy", 0);
    t.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
    expect(Object.values(fns(t)).filter((f: any) => f.Properties.Handler === "dev-agent-handler.handler")).toEqual([]);
    expect(Object.keys(t.findResources("AWS::CloudWatch::Alarm")).filter((id) => id.startsWith("DevAgent"))).toEqual([]);
    expect(Object.keys(t.findOutputs("*")).filter((k) => k.startsWith("DevAgent"))).toEqual([]);
    expect(statementsOf(t, roleOf(t, handlerId(t))).filter(mentionsSqs)).toEqual([]);
  });

  it("is byte-identical to a synth without the parameter", () => {
    expect(synth({ devAgentWorker: "false" }).toJSON()).toEqual(synth({}).toJSON());
  });

  it("refuses any other value", () => {
    expect(() => synth({ devAgentWorker: "yes" })).toThrow(/devAgentWorker: "yes"/);
  });
});

describe("dev agent worker, on", () => {
  let t: Template;
  beforeAll(() => {
    t = synth({ devAgentWorker: "true" });
  });

  it("creates the FIFO queue with its fixed name, no content dedup, 6× visibility, and a FIFO DLQ at 3 receives", () => {
    const dlq = queueId(t, "dilaya-dev-agent-dlq.fifo");
    t.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "dilaya-dev-agent.fifo",
      FifoQueue: true,
      ContentBasedDeduplication: false,
      VisibilityTimeout: 5400,
      SqsManagedSseEnabled: true,
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [dlq, "Arn"] }, maxReceiveCount: 3 },
    });
    t.hasResourceProperties("AWS::SQS::Queue", { QueueName: "dilaya-dev-agent-dlq.fifo", FifoQueue: true });
    t.resourceCountIs("AWS::SQS::Queue", 2);
  });

  it("maps the queue to the worker: batch 1, max concurrency 5, partial batch failures", () => {
    t.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionName: { Ref: workerId(t) },
      EventSourceArn: { "Fn::GetAtt": [queueId(t, "dilaya-dev-agent.fifo"), "Arn"] },
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 5 },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("runs the connector's asset with the dev-agent entry, 900 s, 1024 MB, its own small env", () => {
    const w = fns(t)[workerId(t)].Properties;
    const h = fns(t)[handlerId(t)].Properties;
    expect(w.Timeout).toBe(900);
    expect(w.MemorySize).toBe(1024);
    expect(w.Code).toEqual(h.Code);
    expect(w.Runtime).toBe(h.Runtime);
    expect(Object.keys(w.Environment.Variables).sort()).toEqual(
      ["APP_STATE_TABLE", "CONNECTOR_MCP_URL", "DEV_AGENT_QUEUE_URL", "DEV_AGENT_SSM_PREFIX", "WIF_KMS_KEY_ID", "awsRegion", "registryTableName"]
    );
    expect(w.Environment.Variables.WIF_KMS_KEY_ID).toEqual(h.Environment.Variables.WIF_KMS_KEY_ID);
    expect(w.Environment.Variables.APP_STATE_TABLE).toEqual(h.Environment.Variables.APP_STATE_TABLE);
    expect(w.Environment.Variables.DEV_AGENT_SSM_PREFIX).toBe("/dilaya/_platform/dev-agent/");
  });

  it("adds NOTHING to the connector's environment", () => {
    const h = fns(t)[handlerId(t)].Properties.Environment.Variables;
    const off = synth({});
    expect(Object.keys(h).sort()).toEqual(Object.keys(fns(off)[handlerId(off)].Properties.Environment.Variables).sort());
  });

  it("grants kms:Sign on the WIF key only, SSM under the platform prefix only", () => {
    const st = statementsOf(t, roleOf(t, workerId(t)));
    const kmsKey = Object.keys(t.findResources("AWS::KMS::Key"))[0]!;
    expect(st.filter((s) => JSON.stringify(s.Action).includes("kms:Sign"))).toEqual([
      { Action: "kms:Sign", Effect: "Allow", Resource: { "Fn::GetAtt": [kmsKey, "Arn"] } },
    ]);
    const ssm = st.filter((s) => JSON.stringify(s.Action).includes("ssm:"));
    expect(ssm.flatMap((s) => [].concat(s.Resource))).toEqual([
      "arn:aws:ssm:eu-west-1:123456789012:parameter/dilaya/_platform/dev-agent/*",
      "arn:aws:ssm:eu-west-1:123456789012:parameter/dilaya/_platform/dev-agent",
      "arn:aws:ssm:eu-west-1:123456789012:parameter/dilaya/_platform/dev-agent/*",
    ]);
    const decrypt = st.find((s) => s.Action === "kms:Decrypt");
    expect(decrypt.Condition.StringEquals).toEqual({ "kms:ViaService": "ssm.eu-west-1.amazonaws.com" });
  });

  it("can read/write the app state table, read the registry, and re-enqueue on its own queue", () => {
    const st = statementsOf(t, roleOf(t, workerId(t)));
    const appState = Object.keys(t.findResources("AWS::DynamoDB::Table")).find((id) => id.startsWith("AppStateTable"))!;
    expect(st.some((s) => JSON.stringify(s.Resource).includes(appState) && JSON.stringify(s.Action).includes("dynamodb:PutItem"))).toBe(true);
    const reg = st.find((s) => JSON.stringify(s.Resource).includes("table/registry"));
    expect(reg.Action).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    const q = queueId(t, "dilaya-dev-agent.fifo");
    expect(st.some((s) => s.Action === "sqs:SendMessage" && JSON.stringify(s.Resource) === JSON.stringify({ "Fn::GetAtt": [q, "Arn"] }))).toBe(true);
  });

  it("gives the connector sqs:SendMessage on the queue ARN, and nothing else on SQS", () => {
    const sqsStatements = statementsOf(t, roleOf(t, handlerId(t))).filter(mentionsSqs);
    expect(sqsStatements).toEqual([
      { Action: "sqs:SendMessage", Effect: "Allow", Resource: { "Fn::GetAtt": [queueId(t, "dilaya-dev-agent.fifo"), "Arn"] } },
    ]);
  });

  it("alarms on DLQ depth > 0 and on worker Errors", () => {
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId(t, "dilaya-dev-agent-dlq.fifo"), "QueueName"] } }],
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      Dimensions: [{ Name: "FunctionName", Value: { Ref: workerId(t) } }],
      Threshold: 1,
    });
  });

  it("wires both alarms to the Telegram relay when it is configured", () => {
    const relayed = synth({ devAgentWorker: "true", telegramBotTokenParam: "/x/token", telegramChatId: "1" });
    for (const [id, a] of Object.entries(relayed.findResources("AWS::CloudWatch::Alarm")) as [string, any][]) {
      if (!id.startsWith("DevAgent")) continue;
      expect(a.Properties.AlarmActions).toHaveLength(1);
      expect(a.Properties.OKActions).toHaveLength(1);
    }
  });

  it("outputs the queue, the DLQ and the worker name", () => {
    for (const k of ["DevAgentQueueUrl", "DevAgentQueueArn", "DevAgentDlqUrl", "DevAgentWorkerName"]) {
      expect(Object.keys(t.findOutputs(k))).toEqual([k]);
    }
  });

  it("refuses a pod without a WIF key (secondary without wifKmsKeyArn)", () => {
    expect(() => synth({ ...SECONDARY, devAgentWorker: "true" }, "ca-central-1")).toThrow(/needs the WIF signing key/);
  });
});
