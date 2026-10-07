import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { DMARC_VALUE } from "../lib/stack/app-content/otp-sender";

// t_app_login_first_code (07/10): the content domain carries a DMARC record,
// and the auth Lambda is told the shared login-code sender domain.
describe("login-code sender wiring", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-otp-sender-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(env: Record<string, string> = {}): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    Object.assign(process.env, env);
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  const EDGE = {
    customDomain: "app.dilaya.eu",
    wildcardCertificateArn:
      "arn:aws:acm:eu-west-1:123456789012:certificate/99999999-8888-7777-6666-555555555555",
    appContentDomain: "dilaya-apps.eu",
    appContentZoneId: "Z0123456789ABCDEFGHIJ",
    appContentCertArn:
      "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  };

  it("writes _dmarc on the content domain and hands the auth Lambda the sender domain", () => {
    const t = template(EDGE);
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "_dmarc.dilaya-apps.eu.",
      Type: "TXT",
      ResourceRecords: [`"${DMARC_VALUE}"`],
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ OTP_SENDER_DOMAIN: "dilaya-apps.eu", COGNITO_REGION: Match.anyValue() }) },
    });
  });
});
