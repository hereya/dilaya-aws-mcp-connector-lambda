import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import { EDGE_LOG_PREFIX } from "../constants";
import type { StackContext } from "../context";

export function wireConnectorToAppContent(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentCachePolicy, appContentDistribution, appContentOriginPolicy, appContentOriginSecret, appHostKvs, appHostRouterFn, edgeLogBucket, fn, staticAssetsBucket, staticAssetsOac } = ctx;
  // Called only from inside `if (appContentDomain)`, which also guarantees the
  // zone id (resolveAppContentDomain throws without it).
  const appContentDomain = ctx.appContentDomain!;
  const appContentZoneId = ctx.appContentZoneId!;

  // --- Connector fn env: the connector regenerates the host map at
  //     runtime, so it needs the function name + distribution id.
  fn.addEnvironment("APP_CONTENT_DOMAIN", appContentDomain);
  fn.addEnvironment(
    "APP_CONTENT_CF_FUNCTION_NAME",
    appHostRouterFn.functionName
  );
  fn.addEnvironment(
    "APP_CONTENT_DISTRIBUTION_ID",
    appContentDistribution.distributionId
  );
  // --- BYOD (customer-owned custom domains): the connector lazily creates
  //     ONE standard CloudFront distribution per org at first
  //     set-custom-domain, replicating the app-content behavior — same
  //     API-GW origin + origin-verify secret, the SAME apphost-router
  //     function, and the SAME origin-request policy (referenced by id).
  fn.addEnvironment(
    "APP_CONTENT_ORIGIN_REQUEST_POLICY_ID",
    appContentOriginPolicy.originRequestPolicyId
  );
  // --- Edge static assets + opt-in caching: the connector extracts app
  //     assets/ into the static bucket at deploy-backend, and BYOD
  //     runtime-created distributions replicate the same cache policy +
  //     static origin/behavior (referenced by id).
  // --- Edge access logs: the connector reads them to fold edge-served
  //     traffic into the per-org monthly counter, and stamps the SAME
  //     bucket + prefix on the BYOD distributions it creates at runtime.
  fn.addEnvironment("EDGE_LOG_BUCKET", edgeLogBucket.bucketName);
  fn.addEnvironment("EDGE_LOG_PREFIX", EDGE_LOG_PREFIX);
  fn.addEnvironment(
    "EDGE_LOG_BUCKET_DOMAIN",
    edgeLogBucket.bucketRegionalDomainName
  );
  edgeLogBucket.grantRead(fn);
  fn.addEnvironment("APP_STATIC_BUCKET", staticAssetsBucket.bucketName);
  fn.addEnvironment(
    "APP_STATIC_BUCKET_DOMAIN",
    staticAssetsBucket.bucketRegionalDomainName
  );
  fn.addEnvironment(
    "APP_STATIC_OAC_ID",
    staticAssetsOac.originAccessControlId
  );
  fn.addEnvironment(
    "APP_CONTENT_CACHE_POLICY_ID",
    appContentCachePolicy.cachePolicyId
  );
  staticAssetsBucket.grantReadWrite(fn);
  // --- Host-map KVS: the connector syncs KEYS (data plane) instead of
  //     rewriting function code. DescribeKeyValueStore is the ETag
  //     source every UpdateKeys call must present.
  fn.addEnvironment("APP_HOST_KVS_ARN", appHostKvs.keyValueStoreArn);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
        "cloudfront-keyvaluestore:ListKeys",
        "cloudfront-keyvaluestore:GetKey",
        "cloudfront-keyvaluestore:PutKey",
        "cloudfront-keyvaluestore:DeleteKey",
        "cloudfront-keyvaluestore:UpdateKeys",
      ],
      resources: [appHostKvs.keyValueStoreArn],
    })
  );
  fn.addEnvironment(
    "APP_CONTENT_CF_FUNCTION_ARN",
    appHostRouterFn.functionArn
  );
  if (appContentOriginSecret) {
    fn.addEnvironment(
      "APP_CONTENT_ORIGIN_SECRET",
      appContentOriginSecret
    );
  }
  // --- Sender-domain scheme on the content domain: per-app Postmark
  //     senders live at `<app>--<orgslug>.<appContentDomain>` (matching
  //     the vanity host), with DKIM/return-path records in the content
  //     zone — the first-party connector domain carries no tenant mail.
  //     The connector needs the zone id + record rights on that zone.
  fn.addEnvironment("APP_CONTENT_ZONE_ID", appContentZoneId);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
        "route53:GetHostedZone",
      ],
      resources: [`arn:aws:route53:::hostedzone/${appContentZoneId}`],
    })
  );

  // --- IAM (connector fn role): update ONLY this content function's code
  //     (the baked HOSTMAP). Scoped to the function ARN — nothing else new.
  //     GetFunction is required: regenerateHostMap reads the current code
  //     bytes (GetFunction) to swap only the `var HOSTMAP = {};` line;
  //     DescribeFunction returns config+ETag but NOT the code.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront:GetFunction",
        "cloudfront:DescribeFunction",
        "cloudfront:UpdateFunction",
        "cloudfront:PublishFunction",
      ],
      resources: [
        `arn:aws:cloudfront::${stack.account}:function/${appHostRouterFn.functionName}`,
      ],
    })
  );

}