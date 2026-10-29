import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { crossRegionSsmArns } from "../lib/stack/secondary-pod";

// Région Canada (t_rca_p1_router, blockers B1 + G3). A SECONDARY pod
// (ca-central-1) reads/writes the registry's GLOBAL partitions in the EU table
// (`_hosts`, `_catalog` — sole source of truth, no Global Tables), turns off
// its sweeps that mutate once-per-account resources (POD_ROLE=secondary), and
// may read the eu-west-1 SSM parameter the executor could not resolve (the
// GitHub App key). The primary pod's template stays byte-identical (golden).
const EU_TABLE = "arn:aws:dynamodb:eu-west-1:123456789012:table/eu-registry";
const GH_ARN = "arn:aws:ssm:eu-west-1:123456789012:parameter/hereya/dilayaConnectorGithubPkeyB64/abc";
const CA = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  originDomain: "app-ca.dilaya.eu",
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-secondary-global-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>, projectEnv: Record<string, string> = {}): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://dilaya.eu/oauth/connect" };
  process.env.hereyaProjectEnv = JSON.stringify(projectEnv);
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "SecondaryGlobal", {
    env: { account: "123456789012", region: "ca-central-1" },
  });
  return Template.fromStack(stack);
}
const handlerEnv = (t: Template): Record<string, unknown> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.customDomain !== undefined
  ).Properties.Environment.Variables;
const statements = (t: Template): any[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);

describe("secondary pod: global registry + cross-region static secrets", () => {
  it("injects POD_ROLE=secondary and the EU table ARN on a secondary pod", () => {
    const env = handlerEnv(synth({ ...CA, skipGlobalResources: "true", globalRegistryTableArn: EU_TABLE }));
    expect(env.POD_ROLE).toBe("secondary");
    expect(env.GLOBAL_REGISTRY_TABLE_ARN).toBe(EU_TABLE);
  });

  it("grants the EU table ONLY on the two global partitions (LeadingKeys), never Scan", () => {
    const t = synth({ ...CA, skipGlobalResources: "true", globalRegistryTableArn: EU_TABLE });
    const onEu = statements(t).filter((s) => JSON.stringify(s.Resource) === JSON.stringify(EU_TABLE) && s.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"]);
    expect(onEu).toHaveLength(1);
    expect(onEu[0].Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["_hosts", "_catalog"] },
    });
    expect(onEu[0].Action).not.toContain("dynamodb:Scan");
    expect(onEu[0].Action).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]));
  });

  it("the only other grant on the EU table: a key-only GetItem (an org row EXISTS, never its content)", () => {
    const t = synth({ ...CA, skipGlobalResources: "true", globalRegistryTableArn: EU_TABLE });
    const onEu = statements(t).filter((s) => JSON.stringify(s.Resource) === JSON.stringify(EU_TABLE));
    expect(onEu).toHaveLength(2);
    const keyOnly = onEu.find((s) => !s.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"]);
    expect(keyOnly).toEqual({
      Action: "dynamodb:GetItem",
      Effect: "Allow",
      Resource: EU_TABLE,
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["org_id", "sk"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        Null: { "dynamodb:Attributes": "false" },
      },
    });
  });

  it("grants GetParameter on the exact cross-region SSM ARN left unresolved, + KMS via SSM in ITS region", () => {
    const t = synth({ ...CA, skipGlobalResources: "true" }, { GITHUB_APP_PRIVATE_KEY: `aws:${GH_ARN}`, GITHUB_APP_ID: "1" });
    const all = statements(t);
    const crossRegion = all.filter((s) => JSON.stringify(s.Resource).includes(":ssm:eu-west-1:"));
    expect(crossRegion).toEqual([{ Action: "ssm:GetParameter", Effect: "Allow", Resource: GH_ARN }]);
    const kms = all.find((s) => s.Action === "kms:Decrypt" && JSON.stringify(s.Condition).includes("ssm.eu-west-1"));
    expect(kms.Condition).toEqual({ StringEquals: { "kms:ViaService": ["ssm.eu-west-1.amazonaws.com"] } });
  });

  it("a primary pod gets none of it, even with the same inputs present", () => {
    const t = synth({ ...CA, globalRegistryTableArn: EU_TABLE }, { GITHUB_APP_PRIVATE_KEY: `aws:${GH_ARN}` });
    const env = handlerEnv(t);
    expect(env.POD_ROLE).toBeUndefined();
    expect(env.GLOBAL_REGISTRY_TABLE_ARN).toBeUndefined();
    expect(JSON.stringify(statements(t))).not.toContain("eu-registry");
    expect(JSON.stringify(statements(t))).not.toContain("dilayaConnectorGithubPkeyB64");
  });

  it("refuses a malformed table ARN at synth", () => {
    expect(() => synth({ ...CA, skipGlobalResources: "true", globalRegistryTableArn: "eu-registry" })).toThrow(
      /globalRegistryTableArn must be a DynamoDB table ARN/
    );
  });

  it("crossRegionSsmArns: other-region SSM ARNs only, in any of the three shapes", () => {
    expect(
      crossRegionSsmArns(
        {
          a: `aws:${GH_ARN}`,
          b: `secret://${GH_ARN}`,
          c: "arn:aws:ssm:ca-central-1:123456789012:parameter/local",
          d: "LS0tLS1CRUdJTi",
          e: "secret://plain-value",
        },
        "ca-central-1"
      )
    ).toEqual([{ arn: GH_ARN, region: "eu-west-1" }]);
  });
});
