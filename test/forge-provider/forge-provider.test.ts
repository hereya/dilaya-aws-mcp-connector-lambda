import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

// forgeProvider (lib/stack/forge-provider.ts): "forgejo" → FORGE_PROVIDER=forgejo on
// the connector handler and nowhere else; absent / "" / "github" → the template is
// byte-identical to one synthesized without the parameter; anything else fails the
// synth. Every value here is a placeholder.
const BASE = {
  customDomain: "app.example.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
  hereyaProjectEnv: JSON.stringify({ bucketName: "files-test", s3Prefix: "p-test" }),
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-forge-provider-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://example.eu/oauth/connect" };
  for (const k of ["forgeProvider", "FORGE_PROVIDER", "organizationId"]) delete process.env[k];
  Object.assign(process.env, BASE, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "ForgeProvider", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  return Template.fromStack(stack);
}
const fns = (t: Template) => Object.values(t.findResources("AWS::Lambda::Function")) as any[];
const handlerEnv = (t: Template): Record<string, unknown> =>
  fns(t).find((f) => f.Properties.Environment?.Variables?.customDomain !== undefined).Properties.Environment.Variables;

describe("forgeProvider → FORGE_PROVIDER on the connector", () => {
  let off: Template;
  beforeAll(() => {
    off = synth({});
  });

  test("absent: no FORGE_PROVIDER anywhere", () => {
    expect(handlerEnv(off).FORGE_PROVIDER).toBeUndefined();
    expect(JSON.stringify(off.toJSON())).not.toContain("FORGE_PROVIDER");
  });

  test.each(["", "github"])("%j: the template is byte-identical to the one without the parameter", (value) => {
    expect(JSON.stringify(synth({ forgeProvider: value }).toJSON())).toBe(JSON.stringify(off.toJSON()));
  });

  test("forgejo: FORGE_PROVIDER=forgejo on the connector handler, on no other function, and nothing else changes", () => {
    const on = synth({ forgeProvider: "forgejo" });
    expect(handlerEnv(on).FORGE_PROVIDER).toBe("forgejo");
    expect(fns(on).filter((f) => f.Properties.Environment?.Variables?.FORGE_PROVIDER !== undefined)).toHaveLength(1);
    const stripped = on.toJSON();
    for (const r of Object.values(stripped.Resources) as any[]) delete r.Properties?.Environment?.Variables?.FORGE_PROVIDER;
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(off.toJSON()));
  });

  test.each(["Forgejo", "gitea", "forgejo ", "none", "true"])("%j fails the synth", (value) => {
    expect(() => synth({ forgeProvider: value })).toThrow(/^forgeProvider: ".*" is not a forge — one of: github, forgejo \(absent = github\)$/);
  });
});
