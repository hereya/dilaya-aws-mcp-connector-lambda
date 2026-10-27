import * as cdk from "aws-cdk-lib/core";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { StackContext } from "../context";

/** CloudFront's fixed alias hosted zone (every distribution, every partition region). */
const CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2";

/**
 * THE CUTOVER (t_rca_p1_router step 6): `regionRouterPublicDns=true` points the public names
 * (customDomain, mcp.<zone>) at the region router's distribution instead of API Gateway.
 *
 * The records keep their logical ids (AliasRecord / McpAliasRecord), so the switch — and its
 * rollback, the flag removed — is an in-place UPSERT of the alias target, never a delete +
 * create with a gap. The API Gateway custom domains stay: a resolver still holding the old
 * answer keeps reaching the same pod. The target is resolved LAZILY because the records are
 * built (custom-domain-dns.ts) before the distribution (distribution.ts).
 */
export function publicAliasTarget(ctx: StackContext, apiGateway: route53.IAliasRecordTarget): route53.IAliasRecordTarget {
  return {
    bind(record, zone) {
      if (!ctx.regionRouter?.publicDns) return apiGateway.bind(record, zone);
      return {
        dnsName: cdk.Lazy.string({
          produce: () => {
            if (!ctx.regionRouterDistributionDomain) {
              throw new Error("regionRouterPublicDns=true but the region router distribution was not built");
            }
            return ctx.regionRouterDistributionDomain;
          },
        }),
        hostedZoneId: CLOUDFRONT_ZONE_ID,
      };
    },
  };
}
