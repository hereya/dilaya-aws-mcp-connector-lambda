import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The multi-tenant connector's agent-loop routes must be STATIC (one deployment
// serves every org) and PUBLIC (no JWT authorizer — the poll token is verified
// inside the Lambda). This synth test locks both facts in: the /o/{orgId}/{app}/
// agent/{proxy+} route exists, with no authorizer, while /mcp keeps its
// authorizer. Minimal env (no customDomain / no Cognito) so no Route53 lookup.
describe("static public agent routes", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-synth-"));
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

  it("exposes ANY /o/{orgId}/{app}/agent/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/agent/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /o/{orgId}/{app}/telegram/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/telegram/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("keeps the /mcp route behind the CUSTOM JWT authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /mcp",
      AuthorizationType: "CUSTOM",
    });
  });

  it("the agent route carries no AuthorizerId at all", () => {
    const t = template();
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "ANY /o/{orgId}/{app}/agent/{proxy+}" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });
});
