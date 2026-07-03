import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
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

  it("exposes ANY /o/{orgId}/{app}/secrets/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/secrets/{proxy+}",
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

  it("the secrets route carries no AuthorizerId at all", () => {
    const t = template();
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "ANY /o/{orgId}/{app}/secrets/{proxy+}" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });

  it("grants the connector Lambda ssm:PutParameter + ssm:DeleteParameter covering /secrets/* writes", () => {
    const t = template();
    // The connector role writes+deletes the secret VALUE under /dilaya/*/apps/*
    // (which subsumes /secrets/<name>); the per-app role only READS /secrets/*.
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ssm:PutParameter", "ssm:DeleteParameter"]),
            Resource: Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*"),
          }),
        ]),
      },
    });
  });
});

// F3: the per-app frontend authorizer + auth Lambda are created UNCONDITIONALLY
// (per-app Cognito pools are runtime; there is no deploy-time pool to gate on).
// This locks the guarded→unconditional change: the minimal env below has NO
// Cognito user pool / client, yet both must still exist and be exported to the
// connector Lambda for F3a route plumbing.
describe("F3 per-app auth infra (unconditional)", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-f3-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}"; // no Cognito, no dataApiUrl
    delete process.env.customDomain;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(): Template {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "F3Stack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("creates the REQUEST frontend authorizer with no deploy-time Cognito", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      Name: "FrontendAuthorizerV2",
      AuthorizerType: "REQUEST",
    });
  });

  it("exports FRONTEND_AUTHORIZER_ID + AUTH_INTEGRATION_ID to the connector Lambda", () => {
    const t = template();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FRONTEND_AUTHORIZER_ID: Match.anyValue(),
          AUTH_INTEGRATION_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("grants the connector Lambda tag-agnostic Cognito admin incl. AdminDeleteUser", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:CreateUserPool",
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminDeleteUser",
            ]),
          }),
        ]),
      },
    });
  });
});

describe("per-app IAM roles (app-level isolation)", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-f4-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = JSON.stringify({
      dataApiUrl: "https://abc123.execute-api.eu-west-1.amazonaws.com",
      bucketName: "files-bkt",
      s3Prefix: "dep",
      awsRegion: "eu-west-1",
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
    const stack = new DilayaConnectorLambdaStack(app, "F4Stack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("ships a permissions boundary capped to VM DATA routes + files-bucket S3 (no /admin/*, no IAM)", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "execute-api:Invoke",
            Resource: Match.arrayWith([Match.stringLikeRegexp("abc123/\\*/POST/query")]),
          }),
          Match.objectLike({ Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] }),
        ]),
      },
    });
    // the ceiling must NOT reach the VM admin routes
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("/admin/delete-app");
    expect(json).not.toContain("POST/admin");
  });

  it("caps per-app SSM to own-app mail/secrets params (+ KMS decrypt via SSM only)", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.arrayWith([
              Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*/mail/\\*"),
              Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*/secrets/\\*"),
            ]),
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
            Resource: "*",
            Condition: {
              StringEquals: { "kms:ViaService": Match.stringLikeRegexp("ssm\\..*\\.amazonaws\\.com") },
            },
          }),
        ]),
      },
    });
    // the mail/secrets ceiling must NOT open agent or telegram SSM paths
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("apps/*/telegram/*");
    expect(json).not.toContain("apps/*/agent");
  });

  it("lets the connector CreateRole ONLY under /dilaya-app/ AND only with the boundary attached", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "iam:CreateRole",
            Resource: Match.stringLikeRegexp("role/dilaya-app/\\*"),
            Condition: { StringEquals: Match.objectLike({ "iam:PermissionsBoundary": Match.anyValue() }) },
          }),
        ]),
      },
    });
  });

  it("passes per-app roles to Lambda only", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "iam:PassRole",
            Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
          }),
        ]),
      },
    });
  });

  it("wires the boundary ARN + role path to the connector and drops APP_LAMBDA_ROLE_ARN", () => {
    const t = template();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          APP_LAMBDA_ROLE_PATH: "/dilaya-app/",
          APP_LAMBDA_PERMISSIONS_BOUNDARY_ARN: Match.anyValue(),
        }),
      },
    });
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("APP_LAMBDA_ROLE_ARN");
  });
});
