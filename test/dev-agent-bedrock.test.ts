import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The dev agent's model calls on Bedrock EU (lib/stack/dev-agent-bedrock.ts): inert
// when the list is absent, and when set, the worker gains the env var and the two
// bedrock:InvokeModel statements — nothing else, and nothing on the connector.
const PROJECT_ENV = { registryTableName: "registry", dataApiUrl: "https://data.example" };
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-bedrock-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>, region = "eu-west-1"): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://example.eu/oauth/connect", hereyaProjectEnv: JSON.stringify(PROJECT_ENV) };
  delete process.env.devAgentWorker;
  delete process.env.devAgentBedrockOrgs;
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "BedrockStack", { env: { account: "123456789012", region } });
  return Template.fromStack(stack);
}

const fns = (t: Template): Record<string, any> => t.findResources("AWS::Lambda::Function");
const worker = (t: Template): [string, any] => Object.entries(fns(t)).find(([, f]) => f.Properties.Handler === "dev-agent-handler.handler")!;
const statements = (t: Template): any[] => (Object.values(t.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
const bedrock = (t: Template): any[] => statements(t).filter((s) => JSON.stringify(s.Action).includes("bedrock:"));

describe("dev agent on Bedrock EU", () => {
  it("absent or empty → the worker template is byte-identical, no bedrock statement", () => {
    const base = synth({ devAgentWorker: "true" }).toJSON();
    expect(synth({ devAgentWorker: "true", devAgentBedrockOrgs: "" }).toJSON()).toEqual(base);
    expect(bedrock(synth({ devAgentWorker: "true" }))).toEqual([]);
  });

  it("ignored without the worker", () => {
    const t = synth({ devAgentBedrockOrgs: ORG_A });
    expect(bedrock(t)).toEqual([]);
    expect(JSON.stringify(t.toJSON())).not.toContain("DEV_AGENT_BEDROCK_ORGS");
  });

  it("set → the worker env carries the list; InvokeModel on the 2 eu. profiles and their models, only via the profiles", () => {
    const t = synth({ devAgentWorker: "true", devAgentBedrockOrgs: ` ${ORG_A}, ${ORG_B} ` });
    const [, w] = worker(t);
    expect(w.Properties.Environment.Variables.DEV_AGENT_BEDROCK_ORGS).toBe(`${ORG_A},${ORG_B}`);
    const s = bedrock(t);
    expect(s).toHaveLength(2);
    const profiles = [
      "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-5-5",
    ];
    expect(s[0].Action).toBe("bedrock:InvokeModel");
    expect(s[0].Resource).toEqual(profiles);
    expect(s[0].Condition).toBeUndefined();
    expect(s[1].Action).toBe("bedrock:InvokeModel");
    expect(s[1].Resource).toHaveLength(12);
    expect(s[1].Resource).toContain("arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-5-5");
    expect((s[1].Resource as string[]).every((r) => /^arn:aws:bedrock:eu-[a-z]+-\d::foundation-model\/anthropic\.claude-(haiku|sonnet)-5-5$/.test(r))).toBe(true);
    expect(s[1].Condition).toEqual({ StringLike: { "bedrock:InferenceProfileArn": profiles } });
  });

  it("refuses a malformed list and a non-EU region", () => {
    expect(() => synth({ devAgentWorker: "true", devAgentBedrockOrgs: "not-an-id" })).toThrow(/devAgentBedrockOrgs/);
    expect(() =>
      synth(
        {
          devAgentWorker: "true",
          devAgentBedrockOrgs: ORG_A,
          wifKmsKeyArn: "arn:aws:kms:eu-west-1:123456789012:key/mrk-0123456789abcdef0123456789abcdef",
          customDomain: "app.example.eu",
          customDomainZone: "example.eu",
          wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
          originDomain: "app-ca.example.eu",
          skipGlobalResources: "true",
        },
        "ca-central-1"
      )
    ).toThrow(/EU stack region/);
  });
});
