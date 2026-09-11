import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { StackContext } from "../context";

export function createStaticAssets(stack: cdk.Stack, ctx: StackContext): void {
  const appHostKvs = new cloudfront.KeyValueStore(stack, "AppHostKvs", {
    comment: "dilaya vanity/BYOD host -> {o,a} routing table",
  });

  // -------------------------------------------------------------------
  // Edge-served static assets + opt-in origin caching (2026-07-19).
  //
  // 1. A dedicated static-assets bucket: the connector extracts an app
  //    zip's `assets/` files to `_appstatic/<orgId>/<appName>/...` at
  //    deploy-backend time; the "/static/*" behavior below serves them
  //    straight from S3 (OAC) — no Lambda in the path. Static-MODE apps
  //    (phase 3) additionally keep their whole site bundle under
  //    `_appsite/<orgId>/<appName>/...` in the SAME bucket — the router
  //    function swaps the origin to S3 for those hosts.
  // 2. The default behavior's cache policy respects the ORIGIN's
  //    Cache-Control (opt-in per response; ttl 0 when absent, so every
  //    current response stays uncached). The frontend session cookies are
  //    part of the cache key, so an authenticated response can only ever
  //    be cached under that user's own cookie — never served cross-user.
  //
  // (Defined BEFORE the router function: its code interpolates the
  // bucket's regional domain for the static-mode origin switch.)
  // -------------------------------------------------------------------
  const staticAssetsBucket = new s3.Bucket(stack, "AppStaticAssetsBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
  });
  // Runtime-created BYOD per-org distributions reference this same bucket
  // + OAC (by id, via the envs below): allow ANY distribution of this
  // account to read — CloudFront only presents a SourceArn for distros it
  // actually serves, so this stays account-scoped.
  staticAssetsBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [staticAssetsBucket.arnForObjects("*")],
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      conditions: {
        StringLike: {
          "AWS:SourceArn": `arn:aws:cloudfront::${stack.account}:distribution/*`,
        },
      },
    })
  );
  const staticAssetsOac = new cloudfront.S3OriginAccessControl(
    stack,
    "AppStaticAssetsOac"
  );
  const staticAssetsOrigin =
    origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket, {
      originAccessControl: staticAssetsOac,
    });

  // Viewer-request CloudFront Function (JS 2.0 for the KVS binding).
  ctx.appHostKvs = appHostKvs;
  ctx.staticAssetsBucket = staticAssetsBucket;
  ctx.staticAssetsOac = staticAssetsOac;
  ctx.staticAssetsOrigin = staticAssetsOrigin;
}