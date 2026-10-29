import * as cdk from "aws-cdk-lib/core";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { CLOUDFRONT_FUNCTION_MAX_BYTES } from "../app-content/router-stop-pages";
import type { StackContext } from "../context";
import { createRegionRouterAlarms } from "./alarms";
import { REGION_VERIFY_HEADER } from "./config";
import { viewerFunctionCode } from "./viewer-function";

/**
 * The region router's edge (config.ts says what it is for). Inert unless `regionRouter=true`.
 *
 * Creates NO DNS record of its own: pointing app.dilaya.eu / mcp.<zone> at this distribution is the
 * CUTOVER, `regionRouterPublicDns=true` (public-dns.ts — the pod's existing public records switch
 * their alias target in place; the pod must serve its origin host first, originAlias). Until then
 * the distribution answers only on its *.cloudfront.net name.
 *
 * The KVS starts EMPTY, and an org with no key routes HOME: the day it is switched on, every
 * request goes exactly where it goes today. The CONNECTOR fills it (t_rca_p1_router lot 2,
 * dilaya-connector src/region-router/): REGION_ROUTER_KVS_ARN + the three data-plane actions it
 * calls, on this store only — added here, so a pod without the router gets neither.
 */
export function createRegionRouter(stack: cdk.Stack, ctx: StackContext): void {
  const rr = ctx.regionRouter;
  if (!rr) return;
  const customDomain = ctx.customDomain!;

  const kvs = new cloudfront.KeyValueStore(stack, "RegionRouterKvs", {
    comment: "org id -> region (region router, t_rca_p1_router)",
  });
  ctx.fn.addEnvironment("REGION_ROUTER_KVS_ARN", kvs.keyValueStoreArn);
  // Where the HOME connector relays a mixed-region token's call to a foreign org
  // (dilaya-connector src/region-router/relay.ts) — the edge no longer reads bodies.
  ctx.fn.addEnvironment(
    "REGION_ROUTER_ORIGINS",
    Object.entries(rr.origins).map(([region, host]) => `${region}:${host}`).join(",")
  );
  ctx.fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
        "cloudfront-keyvaluestore:ListKeys",
        "cloudfront-keyvaluestore:UpdateKeys",
      ],
      resources: [kvs.keyValueStoreArn],
    })
  );
  const code = viewerFunctionCode(rr.origins, rr.home);
  if (Buffer.byteLength(code, "utf8") > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error("region-router function exceeds the CloudFront 10 KB code limit");
  }
  const viewerFn = new cloudfront.Function(stack, "RegionRouterFunction", {
    functionName: `${ctx.appLambdaNamePrefix}region-router`,
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    keyValueStore: kvs,
    code: cloudfront.FunctionCode.fromInline(code),
  });

  const edgeLambdas: cloudfront.EdgeLambda[] | undefined = rr.edgeVersionArn
    ? [
        {
          functionVersion: lambda.Version.fromVersionArn(stack, "RegionRouterEdgeVersion", rr.edgeVersionArn),
          eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
          includeBody: true,
        },
      ]
    : undefined;

  const distribution = new cloudfront.Distribution(stack, "RegionRouterDistribution", {
    comment: `region router for ${customDomain}`,
    certificate: acm.Certificate.fromCertificateArn(stack, "RegionRouterCertificate", rr.certArn),
    domainNames: [customDomain, ...(ctx.mcpDomain ? [ctx.mcpDomain] : [])],
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    defaultBehavior: {
      // The home pod. The function / Lambda@Edge swap only the domain name, so
      // this origin's custom header follows the request to every pod.
      origin: new origins.HttpOrigin(rr.origins[rr.home], {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        // API Gateway answers within 30 s; never cut a request it is still serving.
        readTimeout: cdk.Duration.seconds(35),
        customHeaders: { [REGION_VERIFY_HEADER]: rr.originSecret },
      }),
      // API Gateway serves HTTPS only; a redirect would turn a POST into a GET.
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Every viewer header (Authorization included, and the ones the function
      // adds) except Host: API Gateway maps the pod's custom domain on Host.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      functionAssociations: [{ function: viewerFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      edgeLambdas,
    },
  });

  createRegionRouterAlarms(stack, ctx, { distributionId: distribution.distributionId, functionName: viewerFn.functionName });

  ctx.regionRouterDistributionDomain = distribution.distributionDomainName;
  new cdk.CfnOutput(stack, "RegionRouterDistributionDomain", { value: distribution.distributionDomainName });
  new cdk.CfnOutput(stack, "RegionRouterKvsArn", { value: kvs.keyValueStoreArn });
}
