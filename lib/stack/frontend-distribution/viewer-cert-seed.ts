import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import type { StackContext } from "../context";

export function seedViewerCert(stack: cdk.Stack, ctx: StackContext): void {
  const { cloudfrontCertificate, organizationId } = ctx;

  // -----------------------------------------------------------------
  // Custom-domain support wiring
  //
  // The org Lambda exposes MCP tools that swap the distribution's
  // ViewerCertificate in-place when users request vanity domains. We:
  //   1. Seed an SSM param with the bootstrap wildcard cert ARN on
  //      first deploy (onUpdate is a no-op → subsequent deploys don't
  //      overwrite the Lambda's live cert ARN).
  //   2. Grant the org Lambda ACM (tag-scoped) + CloudFront (ARN-scoped)
  //      + SSM (path-scoped) permissions.
  //   3. Pass distribution + function identifiers + SSM path through env.
  //
  // NOTE on drift: if a future CDK stack change touches the Distribution
  // or the CF function, CloudFormation will re-send CDK's inline config
  // and overwrite the Lambda's live state. Remediation is to re-run
  // `check-custom-domains` after the stack update.
  // -----------------------------------------------------------------

  const viewerCertSsmParamName = `/hereya/${organizationId}/viewer-cert-arn`;
  const viewerCertSsmParamArn = `arn:aws:ssm:${stack.region}:${stack.account}:parameter${viewerCertSsmParamName}`;

  const seedViewerCertArn = new cr.AwsCustomResource(
    stack,
    "ViewerCertSsmSeed",
    {
      onCreate: {
        service: "SSM",
        action: "PutParameter",
        parameters: {
          Name: viewerCertSsmParamName,
          Value: cloudfrontCertificate.certificateArn,
          Type: "String",
          Overwrite: false,
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `viewer-cert-seed-${organizationId}`
        ),
        ignoreErrorCodesMatching: "ParameterAlreadyExists",
      },
      onUpdate: {
        service: "SSM",
        action: "GetParameter",
        parameters: { Name: viewerCertSsmParamName },
        physicalResourceId: cr.PhysicalResourceId.of(
          `viewer-cert-seed-${organizationId}`
        ),
        ignoreErrorCodesMatching: "ParameterNotFound",
      },
      onDelete: {
        service: "SSM",
        action: "DeleteParameter",
        parameters: { Name: viewerCertSsmParamName },
        ignoreErrorCodesMatching: "ParameterNotFound",
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            "ssm:PutParameter",
            "ssm:GetParameter",
            "ssm:DeleteParameter",
          ],
          resources: [viewerCertSsmParamArn],
        }),
      ]),
      installLatestAwsSdk: false,
    }
  );
  seedViewerCertArn.node.addDependency(cloudfrontCertificate);
  ctx.seedViewerCertArn = seedViewerCertArn;
  ctx.viewerCertSsmParamArn = viewerCertSsmParamArn;
  ctx.viewerCertSsmParamName = viewerCertSsmParamName;
}