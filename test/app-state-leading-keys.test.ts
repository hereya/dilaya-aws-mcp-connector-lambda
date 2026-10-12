import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// THE FAILURE THIS EXISTS FOR (t_rateauth_leadingkeys, 2026-10-12): 0.1.104
// shipped the login tree's own minute brake — `rateauth#<org>#<app>#<ip>#<min>`,
// 60/min per address, ENFORCING. Its UpdateItem was refused on every single
// call: the authorizer's IAM grant on AppStateTable is conditioned on a
// `dynamodb:LeadingKeys` allow-list that still named four row families, not
// five. The `catch` is fail-open by design, so every site served normally,
// the brake counted nothing (228 refusals in its first 24 h), and nothing
// red said so — rate-guard-auth.test.ts proves the handler WRITES the row,
// nothing proved the role may. The code left before its IAM, again.
//
// So the handler is the oracle: every key prefix the authorizer builds for a
// write into APP_STATE_TABLE must be covered by the LeadingKeys list the stack
// grants it — and the next counter family cannot leave without its grant.
describe("every AppStateTable row family the frontend authorizer writes is in its LeadingKeys grant", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-leading-keys-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    process.env.customDomain = "app.dilaya.eu";
    process.env.customDomainZone = "dilaya.eu";
    process.env.wildcardCertificateArn =
      "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** The prefixes the handler writes: every `<family>#${…}` template literal
   *  that is the start of a partition key it builds. GetItem keys (the
   *  per-app secret) are read on a different grant and are not counters. */
  function writtenPrefixes(): string[] {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "lib", "frontend-authorizer", "index.js"),
      "utf8"
    );
    // A pk builder: `const <x>Pk = (…) =>` followed by a template literal
    // starting with the family name and a `#`.
    const found = [...src.matchAll(/Pk = \([^)]*\) =>\s*`([a-z]+)#/g)].map((m) => m[1]!);
    return [...new Set(found)];
  }

  function grantedLeadingKeys(): string[] {
    const app = new cdk.App({
      context: {
        "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1": {
          Id: "/hostedzone/ZCUSTOMDOMAIN",
          Name: "dilaya.eu.",
        },
      },
    });
    const t = Template.fromStack(
      new DilayaConnectorLambdaStack(app, "LeadingKeysStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      })
    );
    const policies = Object.entries(t.findResources("AWS::IAM::Policy"));
    const authorizerPolicy = policies.find(([id]) => /FrontendAuthorizer/.test(id));
    expect(authorizerPolicy).toBeDefined();
    const statements: any[] = authorizerPolicy![1].Properties.PolicyDocument.Statement;
    const keys = statements
      .filter((s) => [s.Action].flat().includes("dynamodb:UpdateItem"))
      .flatMap((s) => s.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] ?? []);
    return [...new Set(keys as string[])];
  }

  it("the handler's key prefixes are all granted — none may leave before its IAM", () => {
    const written = writtenPrefixes();
    // A grep that finds nothing proves nothing: the four families that were
    // already granted before this test existed must be found by the extraction.
    expect(written).toEqual(
      expect.arrayContaining(["reqcount", "reqcountorg", "ratecount", "ratewin"])
    );
    const granted = grantedLeadingKeys();
    expect(granted.length).toBeGreaterThanOrEqual(4);
    const uncovered = written.filter((p) => !granted.includes(`${p}#*`));
    expect(uncovered).toEqual([]);
  });

  it("the login tree's brake, specifically, is granted (the 0.1.104 hole)", () => {
    expect(writtenPrefixes()).toContain("rateauth");
    expect(grantedLeadingKeys()).toContain("rateauth#*");
  });
});
