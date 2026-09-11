import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function grantCognitoProvisioning(stack: cdk.Stack, ctx: StackContext): void {
  const { fn, triggerArns } = ctx;

  // -----------------------------------------------------------------------
  // Org Lambda: per-app auth provisioning permissions (enable-auth tool).
  //
  // Per-app Cognito pools + clients are created at runtime (resources are
  // only known after CreateUserPool succeeds), so resource="*". The org
  // Lambda needs to attach the shared trigger Lambdas to each new pool
  // (AddPermission) and clean them up on drop-schema (RemovePermission).
  // -----------------------------------------------------------------------

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cognito-idp:CreateUserPool",
        "cognito-idp:DeleteUserPool",
        "cognito-idp:UpdateUserPool",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:ListUserPools",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:UpdateUserPoolClient",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:AdminCreateUser",
        // AdminDeleteUser: remove-user-access tool + runtime users helper.
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:ListUsers",
        "cognito-idp:TagResource",
        // SetUserPoolMfaConfig: reserved for the passwordless-OTP MFA config
        // path (CreateUserPool sets MfaConfiguration OFF inline today; kept so
        // a future enable-auth MFA tweak doesn't need a redeploy).
        "cognito-idp:SetUserPoolMfaConfig",
      ],
      // Multi-tenant: per-app pools are created at RUNTIME for every org, each
      // TAGGED HereyaOrg/HereyaApp, so there is no single org value to scope to
      // (organizationId is empty). resource="*"; per-org isolation is enforced
      // in code (app-auth.ts tags every pool with the chokepoint-resolved orgId).
      resources: ["*"],
    })
  );

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["lambda:AddPermission", "lambda:RemovePermission"],
      resources: triggerArns,
    })
  );
}