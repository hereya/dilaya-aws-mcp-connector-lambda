import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "../context";

export function grantByodDistributions(stack: cdk.Stack, ctx: StackContext): void {
  const { certificate, fn } = ctx;
  // --- IAM (connector fn role): BYOD per-org distributions + certs.
  //     ABAC on the marker tag `dilaya:byod=1`: anything the connector
  //     creates must carry it (RequestTag condition), and every mutation
  //     is gated on the resource carrying it (ResourceTag condition) — so
  //     the connector can never touch non-BYOD certs/distributions (in
  //     particular NOT the shared app-content distribution). Org
  //     segregation itself is enforced by the connector's authz
  //     chokepoint (same trust model as the Cognito admin grant).
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["acm:RequestCertificate", "acm:AddTagsToCertificate"],
      resources: ["*"],
      conditions: {
        StringEquals: { "aws:RequestTag/dilaya:byod": "1" },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["dilaya:byod", "dilaya:orgId"],
        },
      },
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "acm:DescribeCertificate",
        "acm:DeleteCertificate",
        "acm:ListTagsForCertificate",
      ],
      // CloudFront viewer certs live in us-east-1 regardless of the
      // stack's region.
      resources: [`arn:aws:acm:us-east-1:${stack.account}:certificate/*`],
      conditions: {
        StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
      },
    })
  );
  // NOTE: the CreateDistributionWithTags API authorizes against the
  // cloudfront:CreateDistribution action (+ TagResource for the
  // creation-time tags) — there is no CreateDistributionWithTags action.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["cloudfront:CreateDistribution", "cloudfront:TagResource"],
      resources: [
        `arn:aws:cloudfront::${stack.account}:distribution/*`,
      ],
      conditions: {
        StringEquals: { "aws:RequestTag/dilaya:byod": "1" },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["dilaya:byod", "dilaya:orgId"],
        },
      },
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution",
        "cloudfront:TagResource",
        "cloudfront:ListTagsForResource",
        // Live-domain migration: atomically move an alias ONTO the org
        // distribution (cross-account source proven via the `_<alias>`
        // TXT record; the target must already carry a covering cert).
        "cloudfront:AssociateAlias",
        "cloudfront:ListConflictingAliases",
      ],
      resources: [
        `arn:aws:cloudfront::${stack.account}:distribution/*`,
      ],
      conditions: {
        StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
      },
    })
  );

  // --- Domain purchase through Dilaya (Route 53 Domains), opt-in via
  //     the `domainPurchase` param. The route53domains API is GLOBAL
  //     (us-east-1) with NO resource-level scoping and NO tag-based
  //     ABAC — the grant is necessarily account-broad, which is why it
  //     sits behind an explicit deploy param on top of the connector's
  //     own per-org gate (option flag + purchase cap + allowed TLDs,
  //     all fail-closed from org-info). Deliberately NOT granted:
  //     TransferDomain*, DeleteDomain, UpdateDomainContact (contact
  //     changes go through a human, not the connector).
}