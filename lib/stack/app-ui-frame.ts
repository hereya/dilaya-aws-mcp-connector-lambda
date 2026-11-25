import * as cdk from "aws-cdk-lib/core";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type { StackContext } from "./context";
import { appUiResponseHeaders } from "./app-ui-frame-headers";

/**
 * The internal app interface's SANDBOX ORIGIN (t_internal_app_ui, PR1): one
 * CloudFront distribution serving the AI-written static bundles the console
 * shows in `<iframe sandbox="allow-scripts allow-forms">`. Code only, never
 * data: the bundle talks to the console over a MessageChannel, never the net.
 *
 *   appUiFrame absent, "" or "false" → NOTHING is created (template byte-identical).
 *   "true" → distribution + headers policy + cache policy + path guard + DNS,
 *     one bucket statement, output AppUiOrigin, env APP_UI_ORIGIN on the connector.
 *   anything else → the synth FAILS.
 *
 * Its host: `ui.<appContentDomain>` (the app-content wildcard cert + zone), or
 * with `appUiDomain` a dedicated domain, apex of its own zone (appUiZoneId,
 * appUiCertArn in us-east-1). Tenant vanity hosts are `<app>-<slug>`, always
 * hyphenated, so the `ui` label can never be a tenant's.
 *
 * ⚠️ `ui.<appContentDomain>` next to `*.<appContentDomain>` (README "app UI frame"):
 * CloudFront allows the overlap within one account (the more specific name
 * wins, whatever DNS points at), BUT adding the specific alias is refused
 * ("incorrectly configured DNS record") while that name still RESOLVES, via
 * the wildcard record, to the other distribution. So the distribution depends
 * on a TXT record at `ui.<appContentDomain>`: a name with a record of any type
 * no longer matches the wildcard. Unproven on a live account — the S0 spike
 * must prove it; else use the dedicated domain (no wildcard, no conflict).
 *
 * WHAT THE DISTRIBUTION CAN READ: the static-assets bucket's existing policy
 * already lets EVERY distribution of the account read `*` (BYOD distributions
 * are runtime-created), so a bucket policy cannot narrow this one. The boundary
 * is the ORIGIN PATH `/_appui`: CloudFront prefixes every origin request with
 * it, so each key it can ask for starts with `_appui/`. A viewer-request guard
 * refuses `..`, `//`, backslashes and encoded dots/slashes before the cache, so
 * the boundary does not hang on how S3 treats dot segments. The scoped
 * statement added below documents the intent and survives if the broad grant
 * is ever narrowed.
 */
export const PARAM = "appUiFrame";
export const APP_UI_PREFIX = "_appui";
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ORIGIN_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;

/** "true" → on; absent/""/"false" → off; anything else refuses the synth. */
export function appUiFrameEnabled(): boolean {
  const value = process.env[PARAM];
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true") throw new Error(`${PARAM}: "${value.slice(0, 40)}" — expected "true" or "false" (absent = false)`);
  return true;
}

interface UiHost { host: string; certificate: acm.ICertificate; zone: route53.IHostedZone; derived: boolean }

function resolveHost(stack: cdk.Stack, ctx: StackContext): UiHost {
  const domain = process.env["appUiDomain"];
  if (!domain) {
    return { host: `ui.${ctx.appContentDomain}`, certificate: ctx.appContentCertificate, zone: ctx.appContentZone, derived: true };
  }
  if (!HOST_RE.test(domain)) throw new Error(`appUiDomain: "${domain.slice(0, 60)}" is not a lowercase host name`);
  const zoneId = process.env["appUiZoneId"];
  const certArn = process.env["appUiCertArn"];
  if (!zoneId) throw new Error("appUiZoneId is required when appUiDomain is set");
  if (!certArn || !/^arn:aws:acm:us-east-1:\d{12}:certificate\/[\w-]+$/.test(certArn)) {
    throw new Error("appUiCertArn (a us-east-1 ACM certificate ARN) is required when appUiDomain is set");
  }
  return {
    host: domain,
    certificate: acm.Certificate.fromCertificateArn(stack, "AppUiCertificate", certArn),
    zone: route53.HostedZone.fromHostedZoneAttributes(stack, "AppUiZone", { hostedZoneId: zoneId, zoneName: domain }),
    derived: false,
  };
}

/** The console origin allowed to frame the bundles: appUiConsoleOrigin, else the OAuth server's origin (the console's site). */
export function consoleOrigin(ctx: StackContext): string {
  const explicit = process.env["appUiConsoleOrigin"];
  const origin = explicit || new URL(ctx.oauthServerUrl).origin;
  if (!ORIGIN_RE.test(origin)) throw new Error(`appUiConsoleOrigin: "${origin.slice(0, 60)}" must be https://<host>[:port], no path`);
  return origin;
}

// Viewer-request guard: no dot segment, empty segment, backslash or encoded
// dot/slash/backslash may reach the origin (see the boundary note above).
const GUARD_CODE = [
  "function handler(event) {",
  "  var u = event.request.uri;",
  "  if (u.charAt(0) !== '/' || u.indexOf('..') >= 0 || u.indexOf('//') >= 0 ||",
  "      u.indexOf(String.fromCharCode(92)) >= 0 || /%2e|%2f|%5c/i.test(u)) {",
  "    return { statusCode: 400, statusDescription: 'Bad Request' };",
  "  }",
  "  return event.request;",
  "}",
].join("\n");

export function createAppUiFrame(stack: cdk.Stack, ctx: StackContext): void {
  if (!appUiFrameEnabled()) {
    for (const k of ["appUiDomain", "appUiZoneId", "appUiCertArn", "appUiConsoleOrigin"]) {
      if (process.env[k]) throw new Error(`${k} requires ${PARAM}=true (never dropped in silence)`);
    }
    return;
  }
  // The bundles live in the static-assets bucket of THIS pod's app-content edge.
  if (!ctx.appContentDomain || ctx.appContentHostKvsArn || !ctx.staticAssetsBucket) {
    throw new Error(`${PARAM}=true needs this pod's own app-content edge (appContentDomain on a primary pod)`);
  }
  const ui = resolveHost(stack, ctx);
  const filesHost = process.env["filesDomain"] || process.env["filesPublicHost"] || undefined;

  const headers = appUiResponseHeaders(stack, { consoleOrigin: consoleOrigin(ctx), filesHost });
  // Bundle paths are content-hashed (`<org>/<app>/<hash>/…`): a path never
  // changes content, so cache for a year; nothing from the viewer in the key.
  const cachePolicy = new cloudfront.CachePolicy(stack, "AppUiCachePolicy", {
    comment: "App UI bundles: immutable hashed paths, no cookies/query/headers",
    defaultTtl: cdk.Duration.days(365),
    minTtl: cdk.Duration.days(1),
    maxTtl: cdk.Duration.days(365),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });
  const guard = new cloudfront.Function(stack, "AppUiPathGuard", {
    comment: "App UI origin: refuse dot segments and encoded separators",
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    code: cloudfront.FunctionCode.fromInline(GUARD_CODE),
  });

  // A plain S3 origin + the pod's existing OAC set by override: CDK's
  // withOriginAccessControl would also append a `bucket/*` grant for this
  // distribution; the only grant added here is the `_appui/*` one below.
  const origin = origins.S3BucketOrigin.withBucketDefaults(ctx.staticAssetsBucket, { originPath: `/${APP_UI_PREFIX}` });
  const distribution = new cloudfront.Distribution(stack, "AppUiDistribution", {
    comment: "App UI sandbox origin (static bundles, sandboxed iframe)",
    certificate: ui.certificate,
    domainNames: [ui.host],
    defaultBehavior: {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy,
      responseHeadersPolicy: headers,
      functionAssociations: [{ function: guard, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    },
  });
  const cfn = distribution.node.defaultChild as cloudfront.CfnDistribution;
  cfn.addPropertyOverride("DistributionConfig.Origins.0.OriginAccessControlId", ctx.staticAssetsOac.originAccessControlId);

  ctx.staticAssetsBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: "AppUiFrameRead",
      actions: ["s3:GetObject"],
      resources: [ctx.staticAssetsBucket.arnForObjects(`${APP_UI_PREFIX}/*`)],
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      conditions: {
        StringEquals: {
          "AWS:SourceArn": `arn:aws:cloudfront::${stack.account}:distribution/${distribution.distributionId}`,
        },
      },
    })
  );

  if (ui.derived) {
    // The name must stop resolving through `*.<appContentDomain>` BEFORE the
    // alias is added (see the ⚠️ above): a record of another type at the name.
    const nameGuard = new route53.TxtRecord(stack, "AppUiNameGuard", {
      zone: ui.zone,
      recordName: ui.host,
      values: ["dilaya app-ui origin"],
      ttl: cdk.Duration.minutes(5),
    });
    distribution.node.addDependency(nameGuard);
  }
  const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
  new route53.ARecord(stack, "AppUiAliasA", { zone: ui.zone, recordName: ui.host, target });
  new route53.AaaaRecord(stack, "AppUiAliasAAAA", { zone: ui.zone, recordName: ui.host, target });

  const appUiOrigin = `https://${ui.host}`;
  ctx.fn.addEnvironment("APP_UI_ORIGIN", appUiOrigin);
  new cdk.CfnOutput(stack, "AppUiOrigin", { value: appUiOrigin });
}
