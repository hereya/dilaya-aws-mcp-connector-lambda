import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "./context";

export function readStackConfig(stack: cdk.Stack, ctx: StackContext): void {

  const hereyaProjectRootDir = process.env["hereyaProjectRootDir"];
  if (!hereyaProjectRootDir) {
    throw new Error("hereyaProjectRootDir environment variable is required");
  }

  const oauthServerUrl = process.env["oauthServerUrl"];
  if (!oauthServerUrl) {
    throw new Error("oauthServerUrl environment variable is required");
  }

  // Multi-tenant connector: NO single bound org. organizationId is optional
  // and empty here — the authorizer validates the org SET (org_ids) from the
  // single-URL connect AS instead of binding one org at deploy time. The
  // per-org SSM/tag scopings inherited from the source package that reference
  // it become inert (they back frontend/secrets/agent features the connector
  // defers). If ever set, the authorizer falls back to legacy single-org mode.
  const organizationId = process.env["organizationId"] ?? "";

  const memorySize = process.env["memorySize"]
    ? parseInt(process.env["memorySize"])
    : 256;
  const timeout = process.env["timeout"]
    ? parseInt(process.env["timeout"])
    : 30;
  const handlerName = process.env["handler"] ?? "handler.handler";
  const customDomain = process.env["customDomain"];
  const customDomainZone =
    process.env["customDomainZone"] ?? extractDomainZone(customDomain);
  const wildcardCertificateArn = process.env["wildcardCertificateArn"];

  // -----------------------------------------------------------------------
  // App-content domain (host-routing, FLAT scheme). OPTIONAL and additive:
  // absent → this whole feature is inert and existing behaviour is
  // byte-identical. When set, we stand up a dedicated CloudFront distribution
  // that serves per-app frontends at the flat vanity host
  //   <app>--<orgslug>.<appContentDomain>   (e.g. smartcal--novopattern.dilaya-apps.eu)
  // IN ADDITION to the existing path URL https://<customDomain>/o/<org>/<app>/site/.
  //   - appContentDomain   e.g. `dilaya-apps.eu`
  //   - appContentZoneId   the Route53 hosted-zone id for appContentDomain
  //   - appContentCertArn  the us-east-1 ARN of the pre-created `*.<appContentDomain>`
  //                        cert (passed in — NOT created by CDK)
  // -----------------------------------------------------------------------
  const appContentDomain = process.env["appContentDomain"];
  const appContentZoneId = process.env["appContentZoneId"];
  const appContentCertArn = process.env["appContentCertArn"];
  // Un-forgeable origin lock (optional). When set (and appContentDomain is set),
  // the app-content CloudFront distribution stamps this SECRET on every edge->origin
  // request as `x-dilaya-origin-verify`, and the frontend authorizer requires it on
  // site/auth routes. A direct hit on the first-party path URL can't reproduce the
  // secret, so it's denied — unlike the plain `x-dilaya-app-host` marker, which a
  // client can hand-forge. Absent → the authorizer keeps the marker-presence gate.
  const appContentOriginSecret = process.env["appContentOriginSecret"];
  // Transitional acceptance during a secret ROTATION: set this to the OLD
  // secret while rolling the new one (the authorizer accepts either until the
  // CloudFront origin-header updates propagate), then clear it on the next
  // deploy. Empty → strict single-secret mode.
  const appContentOriginSecretPrevious =
    process.env["appContentOriginSecretPrevious"];
  // Per-IP rate guard on tenant frontends (t_80c5ba958ad3). Both optional:
  // the authorizer carries the same defaults, so an unset deployment behaves
  // exactly as the code does. `frontendRateBlock` is the one that matters —
  // it stays "false" (COUNT only: report what WOULD have been refused) until
  // the counted data says who a block would actually cut. A per-IP limit is
  // wrong about shared addresses (corporate NAT, mobile carrier, café), so
  // turning it on is a deliberate act, never a default.
  const frontendRateLimit = process.env["frontendRateLimit"] || "1000";
  // ENFORCING unless explicitly disabled, matching the authorizer's own
  // default. The polarity matters and it bit once: while this read
  // `=== "true" ? "true" : "false"`, the stack kept STAMPING
  // FRONTEND_RATE_BLOCK="false" onto the function, so flipping the default
  // inside the authorizer changed nothing — the explicit env var won, and the
  // guard deployed green while refusing nothing. An env var the stack always
  // sets is not a default; it is an override, and it has to agree with the
  // code it overrides. Caught by reading the deployed function's config
  // rather than trusting the release.
  const frontendRateBlock =
    process.env["frontendRateBlock"] === "false" ? "false" : "true";
  // Domain purchase through Dilaya (Route 53 Domains). OPTIONAL and additive:
  // absent/false → no env, no IAM, feature fully inert connector-side (its
  // tools answer DOMAIN_PURCHASE_NOT_CONFIGURED). Only meaningful together
  // with appContentDomain (the purchased-domain wiring rides the BYOD flow).
  const domainPurchase = process.env["domainPurchase"] === "true";

  // RFC 8707 audience binding: the connector's own /mcp resource URL. Derived
  // from customDomain so it can't be dropped (Hereya only forwards hereyavars
  // backed by a declared app parameter, and a free-form `expectedAudience`
  // var is silently filtered). An explicit override still wins. When set, the
  // authorizer requires the token's aud to match — so a token minted for a
  // different resource can't be replayed here.
  const expectedAudience =
    process.env["expectedAudience"] ||
    (customDomain ? `https://${customDomain}/mcp` : "");
  // Extra request headers the frontend CloudFront distribution should forward to
  // origin (comma-separated). CloudFront strips any header not whitelisted, so
  // custom auth/webhook headers must be listed here. NOTE: `Authorization` CANNOT
  // be added to an OriginRequestPolicy (AWS only allows it via a cache policy) —
  // use a custom header name instead (e.g. X-Dilaya-Agent-Token for the agent poll).
  const additionalForwardedHeaders = (process.env["additionalForwardedHeaders"] ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const frontendForwardHeaders = [
    "Content-Type",
    "Accept-Language",
    "x-forwarded-host",
    "X-Telegram-Bot-Api-Secret-Token",
    // The app-content edge (CloudFront Function) tags the viewer's vanity host
    // in `x-dilaya-app-host`; the origin (auth Lambda / per-app frontend) reads
    // it to scope cookies + emit app-relative redirects. Only added when the
    // host-routing feature is enabled so the feature-off output is unchanged.
    ...(appContentDomain ? ["x-dilaya-app-host"] : []),
    ...additionalForwardedHeaders,
  ].filter((h, i, a) => a.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);

  ctx.appContentCertArn = appContentCertArn;
  ctx.appContentDomain = appContentDomain;
  ctx.appContentOriginSecret = appContentOriginSecret;
  ctx.appContentOriginSecretPrevious = appContentOriginSecretPrevious;
  ctx.appContentZoneId = appContentZoneId;
  ctx.customDomain = customDomain;
  ctx.customDomainZone = customDomainZone;
  ctx.domainPurchase = domainPurchase;
  ctx.expectedAudience = expectedAudience;
  ctx.frontendForwardHeaders = frontendForwardHeaders;
  ctx.frontendRateBlock = frontendRateBlock;
  ctx.frontendRateLimit = frontendRateLimit;
  ctx.handlerName = handlerName;
  ctx.hereyaProjectRootDir = hereyaProjectRootDir;
  ctx.memorySize = memorySize;
  ctx.oauthServerUrl = oauthServerUrl;
  ctx.organizationId = organizationId;
  ctx.timeout = timeout;
  ctx.wildcardCertificateArn = wildcardCertificateArn;
}
/**
 * The hosted zone a custom domain sits in: `app.dilaya.eu` -> `dilaya.eu`,
 * a bare `dilaya.eu` -> itself.
 */
function extractDomainZone(
  customDomain: string | undefined
): string | undefined {
  if (!customDomain) return undefined;
  const parts = customDomain.split(".");
  if (parts.length < 2) throw new Error("Invalid domain name: " + customDomain);
  return parts.length === 2 ? customDomain : parts.slice(1).join(".");
}
