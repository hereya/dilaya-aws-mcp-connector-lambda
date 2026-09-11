import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { StackContext } from "../context";

export function createAppContentPolicies(stack: cdk.Stack, ctx: StackContext): void {
  const { frontendForwardHeaders } = ctx;

  const appContentCachePolicy = new cloudfront.CachePolicy(
    stack,
    "AppContentCachePolicy",
    {
      comment:
        "Respect origin Cache-Control (opt-in); session cookies in the cache key",
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(365),
      cookieBehavior: cloudfront.CacheCookieBehavior.allowList(
        "dilaya_id_token",
        "hereya_id_token",
        "dilaya_agent"
      ),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    }
  );

  // The origin-request policy is SHARED with the runtime-created BYOD
  // per-org distributions (the connector references it by id via
  // APP_CONTENT_ORIGIN_REQUEST_POLICY_ID), so it is hoisted out of the
  // distribution literal.
  const appContentOriginPolicy = new cloudfront.OriginRequestPolicy(
    stack,
    "AppContentOriginPolicy",
    {
      // The frontend session cookies the auth Lambda sets +
      // the frontend authorizer reads (dilaya_* current, hereya_id_token
      // legacy). CloudFront strips any cookie not listed.
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList(
        "dilaya_id_token",
        "hereya_id_token",
        "dilaya_agent"
      ),
      // Base forwarded set + `x-dilaya-app-host` (added to
      // frontendForwardHeaders above when appContentDomain is set).
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        ...frontendForwardHeaders
      ),
      queryStringBehavior:
        cloudfront.OriginRequestQueryStringBehavior.all(),
    }
  );

  // -------------------------------------------------------------------
  // Edge access logs (2026-08-29, t_b8f659db595c).
  //
  // The per-org request cap counts in the frontend authorizer, which only
  // ever sees requests that reach the ORIGIN. A cache hit, and a
  // static-mode site (`static_prefixes: ["/"]`, served straight from S3
  // by the /static behavior and the router's origin swap), are answered
  // at the edge: zero Lambda invocations, zero counters touched. Measured
  // in prod on 2026-08-28 — `GET /` on a static tenant host returned 200
  // with no authorizer invocation at all, while `/auth/login` and
  // `/api/ping` on the SAME app counted 2 of 2. So the cap has a blind
  // spot exactly where traffic is cheapest to serve and easiest to
  // explode, and `get-usage-report` under-counts those orgs.
  //
  // The edge cannot count for us: a CloudFront Function has nowhere to
  // write and its KVS binding is read-only. The access log is therefore
  // the ONLY place this half of the traffic is visible — and it cannot be
  // replaced by a metric, because AWS/CloudFront metrics are per
  // DISTRIBUTION and this one distribution carries every vanity host of
  // every org.
  //
  // LEGACY (v1) logging rather than standard-logging-v2, on purpose: v2
  // offers field selection and hive partitioning, but it is three
  // CloudWatch Logs delivery resources per distribution — and the BYOD
  // per-org distributions are created by the CONNECTOR at runtime, where
  // one property it can set the same way is worth more than smaller
  // files. v1 keys are `<prefix><distId>.<YYYY-MM-DD-HH>.<hash>.gz`, so a
  // single shared prefix still lists chronologically WITHIN one
  // distribution: that is what lets the reader keep one checkpoint per
  // distribution and never read a file twice.
  //
  // 45 days of retention: the counter this feeds is monthly, so the only
  // window that must survive is the current month plus the reader's lag.
  // These logs are not an archive and nothing else reads them.
  ctx.appContentCachePolicy = appContentCachePolicy;
  ctx.appContentOriginPolicy = appContentOriginPolicy;
}