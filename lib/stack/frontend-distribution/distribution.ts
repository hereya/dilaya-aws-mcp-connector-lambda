import * as cdk from "aws-cdk-lib/core";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type { StackContext } from "../context";

export function createFrontendDistribution(stack: cdk.Stack, ctx: StackContext): void {
  const { certificate, cfFunction, cloudfrontCertificate, customDomain, frontendForwardHeaders, hostedZone, httpApi } = ctx;

  // API Gateway origin
  const apiDomainName = cdk.Fn.select(
    2,
    cdk.Fn.split("/", httpApi.apiEndpoint)
  );

  const distribution = new cloudfront.Distribution(
    stack,
    "FrontendDistribution",
    {
      certificate: cloudfrontCertificate,
      domainNames: [`*.${customDomain}`],
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: new cloudfront.OriginRequestPolicy(
          stack,
          "FrontendOriginPolicy",
          {
            cookieBehavior:
              cloudfront.OriginRequestCookieBehavior.allowList(
                "hereya_id_token",
                "hereya_agent"
              ),
            // Base set + `additionalForwardedHeaders` (built at the top of
            // the constructor). CloudFront strips any header not whitelisted
            // here, so custom auth/webhook headers (x-forwarded-host for
            // vanity-host login cookies; X-Telegram-Bot-Api-Secret-Token for
            // the Telegram webhook; X-Dilaya-Agent-Token for the agent poll)
            // must appear in this list or the origin never sees them.
            headerBehavior:
              cloudfront.OriginRequestHeaderBehavior.allowList(
                ...frontendForwardHeaders
              ),
            queryStringBehavior:
              cloudfront.OriginRequestQueryStringBehavior.all(),
          }
        ),
        functionAssociations: [
          {
            function: cfFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    }
  );

  // Route53 wildcard -> CloudFront
  new route53.ARecord(stack, "WildcardAliasRecord", {
    zone: hostedZone,
    recordName: `*.${customDomain}`,
    target: route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(distribution)
    ),
  });

  new cdk.CfnOutput(stack, "FrontendDistributionDomain", {
    value: distribution.distributionDomainName,
  });
  ctx.distribution = distribution;
}