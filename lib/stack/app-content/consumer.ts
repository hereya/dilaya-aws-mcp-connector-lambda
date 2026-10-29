import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "../context";
import { createStaticAssetsBucket } from "./static-assets";
import { createOriginSecretParam } from "./origin-restamp";
import { consumeByodControlPlane } from "./byod-edge";

/**
 * A SECONDARY pod that CONSUMES the primary's app-content edge (Région Canada,
 * t_rca_ca_site_serving). Selected by `appContentHostKvsArn` next to
 * `appContentDomain` + `appContentZoneId` on a `skipGlobalResources=true` pod
 * (pod-topology.ts refuses every other combination).
 *
 * The edge exists ONCE per account and stays the primary's: the `*.<domain>`
 * distribution, its router function, the host-map KVS, the wildcard cert and
 * DNS, the DMARC record, the origin re-stamp trigger. This pod
 * gets only what serving its own orgs' sites through that edge needs:
 *   - its OWN static-assets bucket (the primary's router reaches it by OAC for
 *     a host whose KVS value carries this region, router-region.ts) — its
 *     regional domain is the `AppContentRegionOrigin` output, the exact entry
 *     the primary's `appContentRegionOrigins` takes;
 *   - the connector env + grants to write its hosts into the PRIMARY's
 *     host-map store (each region reaps only its own keys — dilaya-connector
 *     src/custom-domains/kvs-region.ts) and its per-app senders' DNS records
 *     into the content zone;
 *   - the content domain on the frontend authorizer (set by
 *     frontend-authorizer.ts from the same ctx field) and, with
 *     `appContentOriginSecret`, the origin lock + its rotation memory: the
 *     primary's edge stamps the same secret on the requests it sends here;
 *   - the shared login-code sender on the auth Lambda.
 *   - with `appContentByodEdge` (t_rca_byod_ca), the BYOD control plane for its
 *     orgs' custom domains: the primary's BYOD grants + edge ids, so a
 *     distribution created here is the same account resource the primary
 *     would create (byod-edge.ts). Without it the BYOD tools stay off here.
 * Absent `appContentHostKvsArn` → never called: every existing template is unchanged.
 */
export function consumeAppContentEdge(stack: cdk.Stack, ctx: StackContext): void {
  const { fn } = ctx;
  const appContentDomain = ctx.appContentDomain!;
  const zoneId = ctx.appContentZoneId!;
  const kvsArn = ctx.appContentHostKvsArn!;

  const bucket = createStaticAssetsBucket(stack);
  fn.addEnvironment("APP_CONTENT_DOMAIN", appContentDomain);
  fn.addEnvironment("APP_STATIC_BUCKET", bucket.bucketName);
  bucket.grantReadWrite(fn);

  // Same data-plane actions as the primary's own grant (connector-wiring.ts),
  // on the primary's store. The connector signs them in us-east-1 (SigV4a).
  fn.addEnvironment("APP_HOST_KVS_ARN", kvsArn);
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
      resources: [kvsArn],
    })
  );

  // Per-app senders `<app>--<orgslug>.<domain>`: DKIM / return-path records in
  // the content zone (Route 53 is global; the records are per app).
  fn.addEnvironment("APP_CONTENT_ZONE_ID", zoneId);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
        "route53:GetHostedZone",
      ],
      resources: [`arn:aws:route53:::hostedzone/${zoneId}`],
    })
  );

  // The DMARC record of the content domain is the primary's (otp-sender.ts).
  ctx.authLambdaFn?.addEnvironment("OTP_SENDER_DOMAIN", appContentDomain);

  if (ctx.appContentOriginSecret) createOriginSecretParam(stack, ctx);
  // Custom domains of this pod's orgs (t_rca_byod_ca), only with appContentByodEdge.
  if (ctx.appContentByodEdge) consumeByodControlPlane(stack, ctx);

  new cdk.CfnOutput(stack, "AppContentRegionOrigin", {
    description: "This pod's entry for the primary's appContentRegionOrigins",
    value: `${stack.region}:${ctx.originDomain}:${bucket.bucketRegionalDomainName}`,
  });
}
