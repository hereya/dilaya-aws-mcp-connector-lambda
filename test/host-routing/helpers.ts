import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

// -----------------------------------------------------------------------------
// App-content domain host-routing (FLAT scheme). The feature is gated on the
// `appContentDomain` deploy param. WITH the three params set we must stand up:
//   - a CloudFront distribution (alt name *.<appContentDomain> + the passed-in
//     us-east-1 viewer cert ARN) fronting the API-GW custom-domain origin,
//   - a CloudFront FUNCTION (viewer-request) holding the bootstrap host map,
//   - a Route53 A/AAAA wildcard *.<appContentDomain> aliased to the distribution,
//   - APP_CONTENT_* env vars + the 3 cloudfront:* function IAM perms on the
//     connector Lambda.
// WITHOUT the params the whole thing must be absent (feature inert) — locked by
// the existing suites (agent-routes / authorizer) which never set it; a focused
// negative assertion below double-checks the CloudFront function + env are gone.
// -----------------------------------------------------------------------------

/**
 * FunctionCode is a plain string until it embeds a CFN token (the static
 * bucket's RegionalDomainName GetAtt) — then it synths as an Fn::Join. Flatten
 * either shape to one searchable string (tokens inlined as their JSON).
 */
export function fnCodeToString(fc: unknown): string {
  if (typeof fc === "string") return fc;
  const parts = (fc as any)?.["Fn::Join"]?.[1] ?? [];
  return parts
    .map((p: unknown) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join("");
}

export const APP_CONTENT_DOMAIN = "dilaya-apps.eu";
export const APP_CONTENT_ZONE_ID = "Z0APPCONTENT123";
export const APP_CONTENT_CERT_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def-456";

function seedProjectRoot(prefix: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "dist", "handler.js"),
    "exports.handler=async()=>({});"
  );
  return tmpRoot;
}

/** beforeAll/afterAll env for the ENABLED (appContentDomain set) suites. */
export function useAppContentEnv(): void {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = seedProjectRoot("connector-hostrouting-");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    // The content distribution reuses the API-GW custom-domain origin, so the
    // block lives under customDomain. customDomainZone is set explicitly to keep
    // the Route53 lookup hermetic.
    process.env.customDomain = "app.dilaya.eu";
    process.env.customDomainZone = "dilaya.eu";
    process.env.wildcardCertificateArn =
      "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
    process.env.appContentDomain = APP_CONTENT_DOMAIN;
    process.env.appContentZoneId = APP_CONTENT_ZONE_ID;
    process.env.appContentCertArn = APP_CONTENT_CERT_ARN;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
}

export function buildAppContentTemplate(): Template {
  const app = new cdk.App({
    // Seed the customDomain hosted-zone lookup so synth is hermetic.
    context: {
      "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1":
        {
          Id: "/hostedzone/ZCUSTOMDOMAIN",
          Name: "dilaya.eu.",
        },
    },
  });
  const stack = new DilayaConnectorLambdaStack(app, "HostRoutingStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  return Template.fromStack(stack);
}

/** beforeAll/afterAll env for the INERT (no appContentDomain) suite. */
export function useInertEnv(): void {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = seedProjectRoot("connector-noroute-");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.appContentDomain;
    delete process.env.appContentZoneId;
    delete process.env.appContentCertArn;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
}

export function buildInertTemplate(): Template {
  const app = new cdk.App();
  const stack = new DilayaConnectorLambdaStack(app, "NoRouteStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  return Template.fromStack(stack);
}
