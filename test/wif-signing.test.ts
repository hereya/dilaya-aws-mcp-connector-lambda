import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

const PRIMARY_ARN = `arn:aws:kms:eu-west-1:123456789012:key/mrk-${"a".repeat(32)}`;
const POD = {
  customDomain: "app.dilaya.eu",
  customDomainZone: "dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
};
const SECONDARY = { ...POD, originDomain: "app-ca.dilaya.eu", skipGlobalResources: "true" };
const ROOT_ONLY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: "kms:*",
      Effect: "Allow",
      Principal: { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::123456789012:root"]] } },
      Resource: "*",
    },
  ],
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-wif-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>, region = "eu-west-1"): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://dilaya.eu/oauth/connect", hereyaProjectEnv: "{}" };
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "WifStack", { env: { account: "123456789012", region } });
  return Template.fromStack(stack);
}
const handlerEnv = (t: Template): Record<string, unknown> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS !== undefined
  ).Properties.Environment.Variables;
const kmsStatements = (t: Template): any[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[])
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s) => JSON.stringify(s.Action).includes("kms:Sign") || JSON.stringify(s.Action).includes("kms:GetPublicKey"));
const logicalId = (t: Template, type: string): string => Object.keys(t.findResources(type))[0]!;
/** The roles the KMS statement is attached to. */
const rolesOf = (t: Template): unknown[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[])
    .filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes("kms:Sign"))
    .flatMap((p) => p.Properties.Roles);

describe("WIF signing key, primary pod", () => {
  it("is an asymmetric multi-Region RSA_2048 SIGN_VERIFY key, administered by the root, retained", () => {
    const t = synth({});
    t.resourceCountIs("AWS::KMS::Key", 1);
    t.resourceCountIs("AWS::KMS::ReplicaKey", 0);
    t.hasResource("AWS::KMS::Key", {
      Properties: { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", MultiRegion: true, KeyPolicy: ROOT_ONLY },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("has an alias, and outputs the ARN a secondary pod takes as wifKmsKeyArn", () => {
    const t = synth({});
    const id = logicalId(t, "AWS::KMS::Key");
    t.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/WifStack-wif-signing",
      TargetKeyId: { "Fn::GetAtt": [id, "Arn"] },
    });
    t.hasOutput("WifKmsKeyArn", { Value: { "Fn::GetAtt": [id, "Arn"] } });
  });

  it("grants the connector role exactly Sign + GetPublicKey on exactly that key", () => {
    const t = synth({});
    expect(kmsStatements(t)).toEqual([
      {
        Action: ["kms:Sign", "kms:GetPublicKey"],
        Effect: "Allow",
        Resource: { "Fn::GetAtt": [logicalId(t, "AWS::KMS::Key"), "Arn"] },
      },
    ]);
    const fns = Object.values(t.findResources("AWS::Lambda::Function")) as any[];
    const handler = fns.find((f) => f.Properties.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS);
    const role = handler.Properties.Role["Fn::GetAtt"][0];
    expect(rolesOf(t)).toEqual([{ Ref: role }]);
  });

  it("sets WIF_KMS_KEY_ID to the bare key id, not the ARN", () => {
    const t = synth({});
    expect(handlerEnv(t).WIF_KMS_KEY_ID).toEqual({ Ref: logicalId(t, "AWS::KMS::Key") });
  });

  it("refuses wifKmsKeyArn", () => {
    expect(() => synth({ wifKmsKeyArn: PRIMARY_ARN })).toThrow(/wifKmsKeyArn is for a SECONDARY pod/);
  });
});

describe("WIF signing key, secondary pod", () => {
  const ca = () => synth({ ...SECONDARY, wifKmsKeyArn: PRIMARY_ARN }, "ca-central-1");

  it("replicates the primary key, retained, and never creates a primary", () => {
    const t = ca();
    t.resourceCountIs("AWS::KMS::Key", 0);
    t.hasResource("AWS::KMS::ReplicaKey", {
      Properties: { PrimaryKeyArn: PRIMARY_ARN, KeyPolicy: ROOT_ONLY },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    t.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/WifStack-wif-signing",
      TargetKeyId: { "Fn::GetAtt": [logicalId(t, "AWS::KMS::ReplicaKey"), "KeyId"] },
    });
    expect(Object.keys(t.findOutputs("WifKmsKeyArn"))).toEqual([]);
  });

  it("grants and points the connector at the REPLICA of its own region", () => {
    const t = ca();
    const id = logicalId(t, "AWS::KMS::ReplicaKey");
    expect(kmsStatements(t)).toEqual([
      { Action: ["kms:Sign", "kms:GetPublicKey"], Effect: "Allow", Resource: { "Fn::GetAtt": [id, "Arn"] } },
    ]);
    expect(handlerEnv(t).WIF_KMS_KEY_ID).toEqual({ "Fn::GetAtt": [id, "KeyId"] });
  });

  it("without the param: no key, no env, no grant", () => {
    const t = synth(SECONDARY, "ca-central-1");
    t.resourceCountIs("AWS::KMS::Key", 0);
    t.resourceCountIs("AWS::KMS::ReplicaKey", 0);
    t.resourceCountIs("AWS::KMS::Alias", 0);
    expect(handlerEnv(t).WIF_KMS_KEY_ID).toBeUndefined();
    expect(kmsStatements(t)).toEqual([]);
  });

  it.each([
    ["a single-Region key", `arn:aws:kms:eu-west-1:123456789012:key/${"a".repeat(32)}`, /multi-Region KMS key ARN/],
    ["a bare key id", `mrk-${"a".repeat(32)}`, /multi-Region KMS key ARN/],
    ["the pod's own region", PRIMARY_ARN.replace("eu-west-1", "ca-central-1"), /another region/],
  ])("refuses %s", (_label, arn, message) => {
    expect(() => synth({ ...SECONDARY, wifKmsKeyArn: arn }, "ca-central-1")).toThrow(message);
  });
});

describe("WIF public routes", () => {
  const KEYS = ["GET /wif/.well-known/openid-configuration", "GET /wif/jwks.json"];

  it.each([
    ["primary", {}, "eu-west-1"],
    ["secondary", SECONDARY, "ca-central-1"],
  ])("%s pod: public, on the connector Lambda's integration", (_label, env, region) => {
    const t = synth(env as Record<string, string>, region as string);
    const mcp = t.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey: "POST /mcp" } });
    const mcpTarget = JSON.stringify((Object.values(mcp)[0] as any).Properties.Target);
    for (const RouteKey of KEYS) {
      const found = Object.values(t.findResources("AWS::ApiGatewayV2::Route", { Properties: { RouteKey } })) as any[];
      expect(found).toHaveLength(1);
      expect(found[0].Properties.AuthorizationType).toBe("NONE");
      expect(found[0].Properties.AuthorizerId).toBeUndefined();
      expect(JSON.stringify(found[0].Properties.Target)).toBe(mcpTarget);
    }
  });

  it("are covered by the stage's per-route settings", () => {
    const t = synth({});
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      RouteSettings: Match.objectLike(
        Object.fromEntries(KEYS.map((k) => [k, Match.objectLike({ ThrottlingRateLimit: 100 })]))
      ),
    });
  });
});
