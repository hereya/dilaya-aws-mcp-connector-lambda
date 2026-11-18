import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The console door: the customer-space backend calls the connector's
// /console/<op> with a signed assertion (aud bound to the exact op url). A
// route the connector implements but the gateway does not declare answers a
// GATEWAY 404 that no connector test can see — route existence is a property
// of this template, so it is pinned here.
describe("console routes", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-synth-console-"));
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

  it.each([["GET /console/{proxy+}"], ["POST /console/{proxy+}"]])(
    "exposes %s with NO JWT authorizer (the connector verifies a signed assertion)",
    (routeKey) => {
      template().hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    }
  );

  it("does not open any other method on the console path", () => {
    const routes = template().findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes)
      .map((r: any) => r.Properties.RouteKey as string)
      .filter((k) => k.includes("/console"));
    expect(keys.sort()).toEqual(["GET /console/{proxy+}", "POST /console/{proxy+}"]);
  });
});
