import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";
import { FRONT_DOOR_ROUTE_KEYS } from "../../lib/stack/front-door";

// t_app_routing_o1: the route count must stop growing with apps — five static
// routes, one integration, pointing at the frontend authorizer's function.
describe("front door routes", () => {
  let tmpRoot: string;
  const saved = { ...process.env };
  let t: Template;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-fd-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    const app = new cdk.App();
    t = Template.fromStack(new DilayaConnectorLambdaStack(app, "TestStack", { env: { account: "123456789012", region: "eu-west-1" } }));
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("declares the five static routes, unauthorized at the gateway, on one integration", () => {
    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    const fd = routes.filter((r) => FRONT_DOOR_ROUTE_KEYS.includes(r.RouteKey));
    expect(fd.map((r) => r.RouteKey).sort()).toEqual([...FRONT_DOOR_ROUTE_KEYS].sort());
    for (const r of fd) expect(r.AuthorizationType).toBe("NONE");
    const targets = new Set(fd.map((r) => JSON.stringify(r.Target)));
    expect(targets.size).toBe(1);
  });

  it("the integration is the frontend authorizer's own function", () => {
    const ints = t.findResources("AWS::ApiGatewayV2::Integration");
    const fd = Object.entries(ints).find(([id]) => id.startsWith("FrontDoorIntegration"))!;
    expect(JSON.stringify(fd[1].Properties.IntegrationUri)).toContain("FrontendAuthorizerHandler");
  });

  it("the function may invoke tenant backends and the auth Lambda, and has room to wait", () => {
    const fns = t.findResources("AWS::Lambda::Function");
    const fa = Object.entries(fns).find(([id]) => id.startsWith("FrontendAuthorizerHandler"))![1].Properties;
    expect(fa.Timeout).toBe(30);
    expect(fa.Environment.Variables.APP_LAMBDA_NAME_PREFIX).toBeDefined();
    expect(fa.Environment.Variables.AUTH_FUNCTION_NAME).toBeDefined();
    const policies = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("lambda:InvokeFunction");
  });
});
