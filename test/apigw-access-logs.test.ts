import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// A request can fail AT THE GATEWAY (502 malformed response, failed
// integration, 504 integration timeout) without the Lambda ever throwing — so
// `AWS/Lambda Errors` reads 0 — and the connector's handler writes no
// per-request status line, so there is nothing to grep either. The 2026-08-06
// sweep found 20 such 5xx over 7 days, 9 of them in a single hour that two
// earlier sweeps had declared clean, and could not say what any of them were.
//
// Locked in here: the access log group exists with a short retention, the
// default stage actually points at it, the format carries the fields that make
// a 5xx diagnosable (status + the integration fields + caller identity), and
// per-route detailed metrics are on.
describe("HTTP API gateway-level observability", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-apigw-logs-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
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

  it("creates an access log group with short retention", () => {
    // Short on purpose: the sweep reads a 7-day metric window, so two weeks
    // covers every hit it can surface and nothing is kept that is never read.
    template().hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 14,
    });
  });

  it("wires the default stage's access logs at that group", () => {
    const t = template();
    const groups = t.findResources("AWS::Logs::LogGroup", {
      Properties: { RetentionInDays: 14 },
    });
    const groupIds = Object.keys(groups);
    expect(groupIds).toHaveLength(1);

    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AccessLogSettings: Match.objectLike({
        DestinationArn: { "Fn::GetAtt": [groupIds[0], "Arn"] },
      }),
    });
  });

  it("logs the fields that make a gateway 5xx diagnosable", () => {
    const t = template();
    const stages = t.findResources("AWS::ApiGatewayV2::Stage");
    const stage = Object.values(stages).find(
      (s: any) => s.Properties?.StageName === "$default"
    ) as any;
    const format = JSON.parse(stage.Properties.AccessLogSettings.Format);

    // Status alone says a request failed; only the integration fields say
    // WHETHER it was a 502 (malformed response) or a 504 (integration timeout),
    // which is exactly the distinction the 2026-08-05 burst could not be given.
    expect(format.status).toBe("$context.status");
    expect(format.integrationStatus).toBe("$context.integrationStatus");
    expect(format.integrationErrorMessage).toBe(
      "$context.integrationErrorMessage"
    );
    // Route, so a failure can be attributed to /mcp vs a tenant site route.
    expect(format.routeKey).toBe("$context.routeKey");
    // Caller identity, to separate a scanner from one of our own components.
    expect(format.sourceIp).toBe("$context.identity.sourceIp");
    expect(format.userAgent).toBe("$context.identity.userAgent");
  });

  it("enables per-route detailed metrics", () => {
    template().hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: Match.objectLike({ DetailedMetricsEnabled: true }),
    });
  });
});
