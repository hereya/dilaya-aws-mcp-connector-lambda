import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The customer space on dilaya.eu shows an org its DOMAINS — who they are
// registered to, when they expire, whether they renew — and lets the customer
// stop a renewal or ask for the transfer code that takes the name elsewhere.
// dilaya.eu cannot answer any of it alone: the names live in the connector's
// AWS account.
//
// WHY A SYNTH TEST AND NOT A UNIT ONE. The first live domain purchase was
// refused for exactly this reason: a route the dispatch handler implements but
// API Gateway does not declare answers a 404 that comes from the GATEWAY, and
// nothing in the connector's own code or tests can see it. Route existence is
// a property of THIS template, so this is where it is locked in.
describe("org-domains routes (customer space)", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-synth-domains-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    process.env.domainPurchase = "true";
    // The route53domains grant lives under the BYOD/app-content wiring it rides
    // on (customDomain → appContentDomain), exactly as the connector documents:
    // "the BYOD env set must also be present". A test that omits them proves
    // nothing about the grant — it silently exercises the branch where domain
    // purchase does not exist at all.
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

  function template(): Template {
    const app = new cdk.App({
      // Seed the customDomain hosted-zone lookup so synth stays hermetic.
      context: {
        "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1": {
          Id: "/hostedzone/ZCUSTOMDOMAIN",
          Name: "dilaya.eu.",
        },
      },
    });
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  // One route per gesture, each with its own `aud`: an assertion minted to READ
  // a customer's domains must not be replayable to stop their renewal or mint
  // their transfer code. Multiplexing them onto one path would throw that away.
  it.each([
    ["GET /org-domains"],
    ["POST /org-domains/auto-renew"],
    ["POST /org-domains/transfer-code"],
  ])("exposes %s with NO authorizer (dilaya.eu authenticates with a signed assertion)", (routeKey) => {
    template().hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: routeKey,
      AuthorizationType: "NONE",
    });
  });

  // Leaving is a customer right: without these three the connector can show a
  // customer their domain but never hand them the key to it.
  it("grants the transfer-code and transfer-lock actions when domain purchase is on", () => {
    template().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "route53domains:RetrieveDomainAuthCode",
              "route53domains:EnableDomainTransferLock",
              "route53domains:DisableDomainTransferLock",
            ]),
          }),
        ]),
      },
    });
  });

  // The grant that would let the connector move a name away from its owner, or
  // rewrite who the owner IS, stays out — a contact change goes through a human.
  it("still does NOT grant TransferDomain, DeleteDomain or UpdateDomainContact", () => {
    const policies = template().findResources("AWS::IAM::Policy");
    const serialized = JSON.stringify(policies);
    for (const forbidden of [
      "route53domains:TransferDomain",
      "route53domains:DeleteDomain",
      "route53domains:UpdateDomainContact",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
