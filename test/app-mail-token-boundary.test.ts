import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// t_quota_mail_bypass (audit 22/09): an app Lambda that can read its Postmark
// server token can send mail around the org's `maxEmailsMonth`. The boundary is
// what takes it away from every existing per-app role at once. And the login
// Lambda's new OTP counter may write ONE row family, nothing else.
describe("app mail goes through the metered gateway only", () => {
  let tmpRoot: string;
  const saved = { ...process.env };
  let template: Template;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-mailb-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("the per-app boundary grants /secrets/* and never /mail/*", () => {
    const policies = template.findResources("AWS::IAM::ManagedPolicy");
    const doc = JSON.stringify(Object.values(policies).map((p) => p.Properties.PolicyDocument));
    expect(doc).toContain("/secrets/*");
    expect(doc).not.toMatch(/apps\/\*\/mail\/\*/);
  });

  it("the login Lambda's counter write is pinned to otpsend#*", () => {
    const json = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(json).toContain("otpsend#*");
  });
});
