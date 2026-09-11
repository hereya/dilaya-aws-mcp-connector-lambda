import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "../context";

export function grantCustomDomainManagement(stack: cdk.Stack, ctx: StackContext): void {
  const { certificate, cfFunction, distribution, fn, organizationId, seedViewerCertArn, viewerCertSsmParamArn, viewerCertSsmParamName } = ctx;

  // --- ACM (tag-scoped): any cert the org Lambda creates must be
  //     tagged with its own orgId; all non-create actions are gated on
  //     the same tag matching on the resource. This prevents org A from
  //     touching org B's certs.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "acm:RequestCertificate",
        "acm:AddTagsToCertificate",
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "aws:RequestTag/hereya:orgId": organizationId,
        },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": [
            "hereya:orgId",
            "hereya:schema",
            "hereya:domains",
          ],
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
      resources: [
        `arn:aws:acm:us-east-1:${stack.account}:certificate/*`,
      ],
      conditions: {
        StringEquals: {
          "aws:ResourceTag/hereya:orgId": organizationId,
        },
      },
    })
  );

  // --- CloudFront (ARN-scoped): the org Lambda may only update ITS
  //     own distribution and function.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution",
      ],
      resources: [
        `arn:aws:cloudfront::${stack.account}:distribution/${distribution.distributionId}`,
      ],
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cloudfront:GetFunction",
        "cloudfront:DescribeFunction",
        "cloudfront:UpdateFunction",
        "cloudfront:PublishFunction",
      ],
      resources: [
        `arn:aws:cloudfront::${stack.account}:function/${cfFunction.functionName}`,
      ],
    })
  );

  // --- SSM (path-scoped): write the cert ARN on swap.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [viewerCertSsmParamArn],
    })
  );

  // --- Expose IDs to the org Lambda.
  fn.addEnvironment(
    "CLOUDFRONT_DISTRIBUTION_ID",
    distribution.distributionId
  );
  fn.addEnvironment("CLOUDFRONT_FUNCTION_NAME", cfFunction.functionName);
  fn.addEnvironment(
    "CLOUDFRONT_DOMAIN",
    distribution.distributionDomainName
  );
  fn.addEnvironment("VIEWER_CERT_SSM_PARAM", viewerCertSsmParamName);
  fn.node.addDependency(seedViewerCertArn);
}