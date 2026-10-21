import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// t_runtime_users_gateway (21/10): a per-app backend adds or removes a sign-in user
// through the connector, which holds the Cognito grant the app role never had.
describe("app users go through the connector", () => {
  let tmpRoot: string;
  const saved = { ...process.env };
  let template: Template;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-users-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exposes the capability-authenticated users gateway route", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes).map((r) => r.Properties.RouteKey);
    expect(keys).toContain("ANY /o/{orgId}/{app}/users/{proxy+}");
  });
});
