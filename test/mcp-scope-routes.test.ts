import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The org-scope confirmation door: the customer-space backend calls /mcp-scope/<op>
// (an AS-signed assertion per op). A route the connector implements
// but the gateway does not declare answers a GATEWAY 404 that no connector test
// can see — route existence is a property of this template, so it is pinned here.
describe("mcp-scope routes", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-synth-mcpscope-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://as.example.com/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
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

  it.each([["GET /mcp-scope/{proxy+}"], ["POST /mcp-scope/{proxy+}"]])(
    "exposes %s with NO JWT authorizer (the connector verifies the assertion)",
    (routeKey) => {
      template().hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    }
  );

  it("does not open any other method on the mcp-scope path", () => {
    const routes = template().findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes)
      .map((r: any) => r.Properties.RouteKey as string)
      .filter((k) => k.includes("/mcp-scope"));
    expect(keys.sort()).toEqual(["GET /mcp-scope/{proxy+}", "POST /mcp-scope/{proxy+}"]);
  });
});
