import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function grantConnectorSsm(stack: cdk.Stack, ctx: StackContext): void {
  const { fn, organizationId } = ctx;

  // -----------------------------------------------------------------------
  // SSM SecureString for per-app secrets (Telegram bot tokens, etc.).
  // Legacy per-org (organizationId set): tightly bound to that one org's
  // /hereya/{org}/apps/*. Multi-tenant connector (organizationId empty): the
  // single Lambda serves every org, so it needs /dilaya/<anyOrg>/apps/* —
  // per-org isolation is enforced in code (the SSM path is always built from
  // the chokepoint-resolved orgId, never caller input).
  // -----------------------------------------------------------------------

  const agentSecretSsmArn = organizationId
    ? `arn:aws:ssm:${stack.region}:${stack.account}:parameter/hereya/${organizationId}/apps/*`
    : `arn:aws:ssm:${stack.region}:${stack.account}:parameter/dilaya/*/apps/*`;

  // Multi-tenant only: outbound MCP-connection OAuth tokens live at
  // /dilaya/<orgId>/mcp/<connection>/tokens — deliberately OUTSIDE /apps/* so
  // no per-app Lambda role (own-app /apps/<app>/{mail,secrets}/* only) can
  // ever read them. Only the connector reads/writes/refreshes them.
  const mcpTokensSsmArns = organizationId
    ? []
    : [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/dilaya/*/mcp/*`];

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
      ],
      resources: [agentSecretSsmArn, ...mcpTokensSsmArns],
    })
  );

  // NOTE(F3): per-app Lambdas intentionally get NO SSM/KMS/Cognito grants in
  // public v1. The prior grants here were cross-tenant (ssm:GetParameter on
  // /dilaya/*/apps/* reaches every org's secrets; the Cognito grant keyed off
  // an empty organizationId). F3 (per-app auth + secrets) re-adds them scoped
  // per-org via the same capability/tag discipline used for the DB.

  // KMS decrypt for the AWS-managed SSM key (SecureString).
  // Scoped via ViaService condition so it only works through SSM.
  const ssmKmsDecrypt = new iam.PolicyStatement({
    actions: ["kms:Decrypt"],
    resources: ["*"],
    conditions: {
      StringEquals: {
        "kms:ViaService": `ssm.${stack.region}.amazonaws.com`,
      },
    },
  });
  fn.addToRolePolicy(ssmKmsDecrypt);
  // (per-app Lambda SSM/KMS/Cognito grants removed — see NOTE(F3) above; each
  //  per-app role is created at runtime by the connector, capped by the boundary.)

}