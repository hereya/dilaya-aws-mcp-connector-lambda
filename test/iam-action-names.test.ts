import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as r53d from "@aws-sdk/client-route-53-domains";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// THE FAILURE THIS EXISTS FOR: an IAM action that does not exist grants NOTHING,
// and says nothing. IAM accepts `route53domains:GetDomainAuthCode` — a plausible
// name for an API actually called RetrieveDomainAuthCode — CloudFormation
// deploys it, every synth assertion that the action is "in the policy" passes,
// and the call fails with AccessDenied in production, on the one path a customer
// takes when they want to LEAVE.
//
// It happened here on 2026-09-07, between publishing 0.1.63 and writing the
// connector code that uses the grant: the SDK's command name is what betrayed
// it. So the SDK is the oracle — every `route53domains:<Action>` this stack
// grants must correspond to an `<Action>Command` the client exports. A typo is
// then a failing test rather than a permission that quietly is not there.
//
// Scoped to route53domains because that is the client this package has a reason
// to depend on; the same shape extends to any service worth the devDependency.
describe("IAM action names are real API actions", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-iam-names-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    process.env.domainPurchase = "true";
    process.env.customDomain = "app.dilaya.eu";
    process.env.customDomainZone = "dilaya.eu";
    process.env.wildcardCertificateArn =
      "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
    process.env.appContentDomain = "dilaya-apps.eu";
    process.env.appContentZoneId = "ZAPPCONTENT";
    process.env.appContentCertArn =
      "arn:aws:acm:us-east-1:123456789012:certificate/app-content-cert";
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function grantedRoute53DomainsActions(): string[] {
    const app = new cdk.App({
      context: {
        "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1": {
          Id: "/hostedzone/ZCUSTOMDOMAIN",
          Name: "dilaya.eu.",
        },
      },
    });
    const t = Template.fromStack(
      new DilayaConnectorLambdaStack(app, "IamNamesStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      })
    );
    const found = JSON.stringify(t.findResources("AWS::IAM::Policy")).match(
      /"route53domains:[A-Za-z]+"/g
    );
    return [...new Set((found ?? []).map((s) => s.replace(/"/g, "").split(":")[1]!))];
  }

  it("every route53domains action granted exists in the AWS SDK's command list", () => {
    const actions = grantedRoute53DomainsActions();
    // A grep that finds nothing proves nothing — if the extraction breaks, this
    // test would pass while checking an empty list.
    expect(actions.length).toBeGreaterThan(10);

    const exported = new Set(Object.keys(r53d));
    const unknown = actions.filter((a) => !exported.has(`${a}Command`));
    expect(unknown).toEqual([]);
  });

  it("the oracle itself is sound: an invented action would be caught", () => {
    // Guards the guard — if `exported` were ever empty or the naming convention
    // changed, the check above would silently accept anything.
    expect(Object.keys(r53d)).toContain("RetrieveDomainAuthCodeCommand");
    expect(Object.keys(r53d)).not.toContain("GetDomainAuthCodeCommand");
  });
});
