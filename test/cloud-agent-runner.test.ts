import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The cloud-agent runner: the connector's bundle under a second entry point, 15
// minutes, invoked by the connector only. What must hold: it has no route, a
// thrown invocation is never retried (a retry is a SECOND run), it receives the
// harness package's outputs, and the connector may invoke it — and nothing else.
describe("cloud-agent runner Lambda", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-runner-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = JSON.stringify({
      agentcoreExecutionRoleArn: "arn:aws:iam::123456789012:role/harness-exec",
      agentcoreHarnessTag: "dilaya:cloud-agent=1",
    });
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

  const runnerId = (t: Template) =>
    Object.keys(t.findResources("AWS::Lambda::Function", { Properties: { Handler: "handler.runnerHandler" } }));

  it("is ONE function on the connector's bundle, 15 minutes, with what a run reads", () => {
    const t = template();
    expect(runnerId(t)).toHaveLength(1);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "handler.runnerHandler",
      Timeout: 900,
      Environment: {
        Variables: Match.objectLike({
          agentcoreExecutionRoleArn: "arn:aws:iam::123456789012:role/harness-exec",
          agentcoreHarnessTag: "dilaya:cloud-agent=1",
          awsRegion: "eu-west-1",
          APP_STATE_TABLE: Match.anyValue(),
          OAUTH_SERVER_URL: "https://dilaya.eu/oauth/connect",
        }),
      },
    });
  });

  it("shares the connector's role — the AgentCore grants land there", () => {
    const t = template();
    const fns = t.findResources("AWS::Lambda::Function");
    const runner = fns[runnerId(t)[0]];
    const handler = Object.values(fns).find((f: any) => f.Properties.Handler === "handler.handler") as any;
    expect(runner.Properties.Role).toEqual(handler.Properties.Role);
  });

  it("never retries a thrown invocation: a retried run is a second run", () => {
    const t = template();
    t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      FunctionName: { Ref: runnerId(t)[0] },
      MaximumRetryAttempts: 0,
    });
  });

  it("the connector knows its name and may invoke it — that function only", () => {
    const t = template();
    const id = runnerId(t)[0];
    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "handler.handler",
      Environment: { Variables: Match.objectLike({ CLOUD_AGENT_RUNNER_FUNCTION: { Ref: id } }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [{ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { "Fn::GetAtt": [id, "Arn"] } }],
      },
    });
  });

  it("has no route and no public permission", () => {
    const t = template();
    const id = runnerId(t)[0];
    for (const p of Object.values(t.findResources("AWS::Lambda::Permission")) as any[]) {
      expect(JSON.stringify(p.Properties.FunctionName)).not.toContain(id);
    }
  });
});
