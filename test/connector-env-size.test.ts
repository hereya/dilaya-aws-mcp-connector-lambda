// 2026-09-21: the release that pinned dilaya/aws-agentcore-harness died on
// "environment variables … exceeded the 4KB limit. Measured size: 4152 bytes" —
// UPDATE_FAILED on the Handler, stack rolled back. Nothing before the real
// deploy measures the environment, so this does.
import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { useStackFixture } from "./core-alarms/helpers";
import { resolvedEnvBytes } from "./helpers/env-size";

function handlerEnv(t: Template): Record<string, unknown> {
  const fns = Object.values(t.findResources("AWS::Lambda::Function")) as any[];
  const handler = fns.find((f) => f.Properties?.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS);
  return handler.Properties.Environment.Variables;
}

describe("the connector Lambda's environment", () => {
  const template = useStackFixture("connector-env-size-", "EnvSizeStack");

  test("carries the four Cognito triggers as function NAMES — the ARN prefix is not written four times", () => {
    const v = handlerEnv(template()).COGNITO_TRIGGER_LAMBDA_ARNS as any;
    const parts = v["Fn::Join"][1] as any[];
    // Four `Ref`s (a Lambda's Ref is its NAME) joined by commas — no GetAtt Arn.
    expect(parts.filter((p) => typeof p === "object" && p.Ref)).toHaveLength(4);
    expect(JSON.stringify(v)).not.toContain("Fn::GetAtt");
  });
});

// ---------------------------------------------------------------------------
// The WEIGHT of the environment (t_env_4kb_headroom). Synthesized the way prod
// is deployed — same features on, a stack name as long as prod's (secret names
// and the cron group are built from it), and a hereyaProjectEnv with prod's keys
// at prod's value lengths (the connector's pinned packages + parameters, read on
// the live Handler 2026-09-22; values are dummies). A package pinned later adds
// its outputs here too: add them to PROJECT_ENV when you pin it.
// ---------------------------------------------------------------------------

/** Lambda's cap is 4096; the rest is room for a future pin, and for our pricing being off. */
const BUDGET = 3700;

const PROD_STACK_NAME = "p-e75e2b77-f895-4255-842d-f1561246ab01"; // 38 chars, like prod's

const PROJECT_ENV: Record<string, string> = {
  registryTableName: "r".repeat(74),
  sqliteReplicaBucketName: "b".repeat(63),
  dataApiUrl: "https://" + "d".repeat(46),
  bucketName: "b".repeat(47),
  s3Prefix: "p".repeat(38),
  ALARM_INBOX_ORG: "o".repeat(36),
  postmarkApiBaseUrl: "https://" + "p".repeat(19),
  GITHUB_REPOS_ORG: "g".repeat(15),
  FILES_PUBLIC_HOST: "f".repeat(15),
  ALARM_INBOX_APP: "a".repeat(9),
  GITHUB_APP_INSTALLATION_ID: "1".repeat(9),
  GITHUB_APP_ID: "1".repeat(7),
  ROUTE53_DOMAIN_ACCOUNT_LIMIT: "20",
  // secret:// → the Lambda sees `/<stackName>/<key>` + a SECRET_KEYS list.
  GITHUB_APP_PRIVATE_KEY: "secret://x",
  postmarkAccountToken: "secret://x",
  capabilitySecretArn: "secret://x",
  OPENAI_API_KEY: "secret://x",
};

describe("the connector Lambda's environment, resolved as in prod", () => {
  let root: string;
  const saved = { ...process.env };
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-env-weight-"));
    fs.mkdirSync(path.join(root, "dist", "layer"), { recursive: true }); // prod ships the runtime layer
    fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function prodTemplate(): Template {
    process.env = {
      ...saved,
      hereyaProjectRootDir: root,
      oauthServerUrl: "https://dilaya.eu/oauth/connect",
      hereyaProjectEnv: JSON.stringify(PROJECT_ENV),
      customDomain: "app.dilaya.eu",
      wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
      appContentDomain: "dilaya-apps.eu",
      appContentZoneId: "Z".repeat(21),
      appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/y",
      appContentOriginSecret: "s".repeat(64),
      domainPurchase: "true",
    };
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, PROD_STACK_NAME, {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  test(`stays under ${BUDGET} bytes of Lambda's 4096`, () => {
    const t = prodTemplate();
    const vars = handlerEnv(t);
    const bytes = resolvedEnvBytes(vars, t.toJSON().Resources);
    // Every variable prod carries, so a missed one cannot flatter the figure.
    expect(Object.keys(vars).length).toBeGreaterThanOrEqual(50);
    expect(bytes).toBeLessThanOrEqual(BUDGET);
  });

  test("does not carry what the connector rebuilds (bucket domains, the router's ARN)", () => {
    const vars = handlerEnv(prodTemplate());
    for (const k of ["EDGE_LOG_BUCKET_DOMAIN", "APP_STATIC_BUCKET_DOMAIN", "APP_CONTENT_CF_FUNCTION_ARN"]) {
      expect(vars[k]).toBeUndefined();
    }
    // …and does carry what it rebuilds them FROM.
    for (const k of ["EDGE_LOG_BUCKET", "APP_STATIC_BUCKET", "APP_CONTENT_CF_FUNCTION_NAME", "awsRegion", "AWS_ACCOUNT_ID"]) {
      expect(vars[k]).toBeDefined();
    }
  });
});
