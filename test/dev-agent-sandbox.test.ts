import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { sandboxImageName, SANDBOX_IMAGE_DIR } from "../lib/stack/dev-agent-sandbox";

// The dev agent's sandbox computer (lib/stack/dev-agent-sandbox.ts): inert when the list is
// absent; when set, ONE MicroVM image + its two roles, and the worker may drive MicroVMs of
// that image only — nothing on the connector.
const PROJECT_ENV = { registryTableName: "registry", dataApiUrl: "https://data.example" };
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-sandbox-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://example.eu/oauth/connect", hereyaProjectEnv: JSON.stringify(PROJECT_ENV) };
  delete process.env.devAgentWorker;
  delete process.env.devAgentSandboxOrgs;
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "SandboxStack", { env: { account: "123456789012", region: "eu-west-1" } });
  return Template.fromStack(stack);
}

const fns = (t: Template): Record<string, any> => t.findResources("AWS::Lambda::Function");
const worker = (t: Template): any => Object.values(fns(t)).find((f: any) => f.Properties.Handler === "dev-agent-handler.handler");
const connector = (t: Template): any[] => Object.values(fns(t)).filter((f: any) => f.Properties.Handler !== "dev-agent-handler.handler");
const statements = (t: Template): any[] => (Object.values(t.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
const microvm = (t: Template): any[] => statements(t).filter((s) => /Microvm|NetworkConnector/.test(JSON.stringify(s.Action)));

test("absent or empty: no image, no env, no statement", () => {
  for (const env of [{ devAgentWorker: "true" } as Record<string, string>, { devAgentWorker: "true", devAgentSandboxOrgs: "  " }]) {
    const t = synth(env);
    expect(Object.keys(t.findResources("AWS::Lambda::MicrovmImage"))).toHaveLength(0);
    expect(Object.keys(worker(t).Properties.Environment.Variables).filter((k) => k.startsWith("DEV_AGENT_SANDBOX"))).toEqual([]);
    expect(microvm(t)).toEqual([]);
  }
});

test("set: one image (ARM64, managed base, hooks on 9000, internet egress) built from the asset", () => {
  const t = synth({ devAgentWorker: "true", devAgentSandboxOrgs: `${ORG_A}, ${ORG_B}` });
  const images = Object.values(t.findResources("AWS::Lambda::MicrovmImage")) as any[];
  expect(images).toHaveLength(1);
  const p = images[0].Properties;
  expect(p.Name).toBe(sandboxImageName("SandboxStack"));
  expect(JSON.stringify(p.BaseImageArn)).toContain(":aws:microvm-image:al2023-1");
  expect(p.CpuConfigurations).toEqual([{ Architecture: "ARM_64" }]);
  expect(p.Hooks.Port).toBe(9000);
  expect(p.Hooks.MicrovmImageHooks.Ready).toBe("ENABLED");
  expect(JSON.stringify(p.EgressNetworkConnectors)).toContain("aws-network-connector:INTERNET_EGRESS");
  expect(JSON.stringify(p.CodeArtifact.Uri)).toContain("s3://");
  // root needs CAP_SYS_ADMIN to create the egress lock (network namespace) (lib/sandbox-image/egress.mjs).
  expect(p.AdditionalOsCapabilities).toEqual(["ALL"]);
});

test("set: the worker gets the three env vars and drives MicroVMs of THAT image only", () => {
  const t = synth({ devAgentWorker: "true", devAgentSandboxOrgs: ORG_A });
  const vars = worker(t).Properties.Environment.Variables;
  expect(vars.DEV_AGENT_SANDBOX_ORGS).toBe(ORG_A);
  expect(vars.DEV_AGENT_SANDBOX_IMAGE_ARN).toEqual({ "Fn::GetAtt": [expect.any(String), "ImageArn"] });
  expect(vars.DEV_AGENT_SANDBOX_EXEC_ROLE_ARN).toEqual({ "Fn::GetAtt": [expect.any(String), "Arn"] });
  const run = microvm(t).find((s) => JSON.stringify(s.Action).includes("RunMicrovm"));
  expect(run.Resource).toEqual({ "Fn::GetAtt": [expect.any(String), "ImageArn"] });
  expect(statements(t).some((s) => s.Action === "lambda:CreateMicrovmImage" || s.Resource === "*" && /Microvm/.test(JSON.stringify(s.Action)))).toBe(false);
  const pass = statements(t).find((s) => s.Action === "iam:PassRole" && s.Condition?.StringEquals?.["iam:PassedToService"] === "lambda.amazonaws.com");
  expect(pass).toBeDefined();
  for (const f of connector(t)) expect(Object.keys(f.Properties.Environment?.Variables ?? {}).filter((k) => k.startsWith("DEV_AGENT_SANDBOX"))).toEqual([]);
});

test("the VM roles trust Lambda for THIS account and image only", () => {
  const t = synth({ devAgentWorker: "true", devAgentSandboxOrgs: ORG_A });
  const roles = (Object.values(t.findResources("AWS::IAM::Role")) as any[]).filter((r) => JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("microvm-image"));
  expect(roles).toHaveLength(2);
  for (const r of roles) {
    const st = r.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(st.Principal).toEqual({ Service: "lambda.amazonaws.com" });
    expect(st.Condition.StringEquals["aws:SourceAccount"]).toBe("123456789012");
  }
});

test("a malformed list fails the synth", () => {
  expect(() => synth({ devAgentWorker: "true", devAgentSandboxOrgs: "acme" })).toThrow(/devAgentSandboxOrgs/);
});

test("image name: valid charset, ≤ 64, stable", () => {
  const n = sandboxImageName("p-" + "x".repeat(80) + ".weird");
  expect(n).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
  expect(sandboxImageName("abc")).toBe(sandboxImageName("abc"));
});

test("the image directory has a Dockerfile FROM the managed base and the control server", () => {
  const df = fs.readFileSync(path.join(SANDBOX_IMAGE_DIR, "Dockerfile"), "utf8");
  expect(df).toMatch(/^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal$/m);
  expect(df).toContain("EXPOSE 8080 9000");
  // The base container's dnf IS microdnf: a dnf-only option (--allowerasing) fails the service build at once.
  const code = df.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  expect(code).not.toMatch(/--allowerasing/);
  expect(code).not.toMatch(/^RUN dnf /m);
  expect(fs.existsSync(path.join(SANDBOX_IMAGE_DIR, "server.mjs"))).toBe(true);
  // The egress lock ships in the image: util-linux (unshare/nsenter/setpriv) + iproute, egress.mjs
  // and forwarder.mjs next to the server. No nftables: the MicroVM kernel has no nf_tables.
  expect(code).toMatch(/microdnf install[^\n]* util-linux/);
  expect(code).toMatch(/microdnf install[^\n]* iproute/);
  expect(code).not.toMatch(/nftables/);
  expect(code).toMatch(/^COPY [^\n]*egress\.mjs[^\n]*forwarder\.mjs/m);
});
