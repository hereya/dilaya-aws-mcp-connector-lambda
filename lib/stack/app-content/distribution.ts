import * as cdk from "aws-cdk-lib/core";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { EDGE_LOG_PREFIX } from "../constants";
import type { StackContext } from "../context";

export function createAppContentDistribution(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentCachePolicy, appContentCertificate, appContentOriginPolicy, appContentOriginSecret, appContentZone, appHostRouterFn, certificate, staticAssetsOrigin } = ctx;
  // Called only from inside `if (customDomain && customDomainZone)` /
  // `if (appContentDomain)`.
  const appContentDomain = ctx.appContentDomain!;
  const customDomain = ctx.customDomain!;
  const edgeLogBucket = new s3.Bucket(stack, "EdgeAccessLogBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    // CloudFront v1 log delivery writes each object with an ACL grant to
    // the log-delivery account, so the bucket must accept ACLs at all.
    // BUCKET_OWNER_PREFERRED is what CDK itself uses for the bucket it
    // creates when `enableLogging` is set without one, and it keeps every
    // delivered object owned by this account.
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    lifecycleRules: [{ expiration: cdk.Duration.days(45) }],
  });

  // Same API-GW custom-domain origin as the path URL. Default HttpOrigin
  // Host = `customDomain`, so API Gateway's domain mapping still matches.
  const appContentDistribution = new cloudfront.Distribution(
    stack,
    "AppContentDistribution",
    {
      certificate: appContentCertificate,
      domainNames: [`*.${appContentDomain}`],
      enableLogging: true,
      logBucket: edgeLogBucket,
      logFilePrefix: EDGE_LOG_PREFIX,
      // Cookies are the frontend SESSION cookies. They are never needed
      // to count a request against an org and would put a live session
      // identifier in a log this reader does not otherwise touch.
      logIncludesCookies: false,
      defaultBehavior: {
        origin: new origins.HttpOrigin(customDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          // Un-forgeable origin lock: stamp the shared secret on every
          // edge->origin request. Only this distribution knows it, so a
          // direct app.dilaya.eu hit (no CloudFront) can't reproduce it.
          // Added only when the secret is configured (else feature-off).
          ...(appContentOriginSecret
            ? {
                customHeaders: {
                  "x-dilaya-origin-verify": appContentOriginSecret,
                },
              }
            : {}),
        }),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: appContentCachePolicy,
        originRequestPolicy: appContentOriginPolicy,
        functionAssociations: [
          {
            function: appHostRouterFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // Matched on the VIEWER uri; the router function (attached here
        // too) rewrites /static/* -> /_appstatic/<org>/<app>/* so each
        // tenant's assets resolve under its own S3 key prefix.
        "/static/*": {
          origin: staticAssetsOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: [
            {
              function: appHostRouterFn,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    }
  );

  // Route53 wildcard A + AAAA -> the content distribution.
  new route53.ARecord(stack, "AppContentWildcardA", {
    zone: appContentZone,
    recordName: `*.${appContentDomain}`,
    target: route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(appContentDistribution)
    ),
  });
  new route53.AaaaRecord(stack, "AppContentWildcardAAAA", {
    zone: appContentZone,
    recordName: `*.${appContentDomain}`,
    target: route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(appContentDistribution)
    ),
  });

  ctx.appContentDistribution = appContentDistribution;
  ctx.edgeLogBucket = edgeLogBucket;
}