import * as cdk from "aws-cdk-lib/core";
import { SecretValue } from "aws-cdk-lib/core";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type { StackContext } from "./context";

export function readProjectEnv(stack: cdk.Stack, ctx: StackContext): void {
  const { customDomain } = ctx;
  // Parse hereyaProjectEnv
  const env: Record<string, string> = JSON.parse(
    process.env["hereyaProjectEnv"] ?? "{}"
  );

  // Separate IAM policy env vars
  const policyEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key.startsWith("IAM_POLICY_") || key.startsWith("iamPolicy")
    )
  );

  const nonPolicyEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("IAM_POLICY_") && !key.startsWith("iamPolicy")
    )
  );

  // Separate secret env vars (secret:// prefix)
  const secretEnvEntries = Object.entries(nonPolicyEnv)
    .filter(([, value]) => (value as string).startsWith("secret://"))
    .map(([key, value]) => {
      const plainValue = (value as string).split("secret://")[1];
      const secretName = `/${stack.stackName}/${key}`;
      const secret = new secrets.Secret(stack, key, {
        secretName,
        secretStringValue: SecretValue.unsafePlainText(plainValue),
      });
      return { key, secret, secretName };
    });

  // The capability signing secret arrives as a secret:// value (hereya resolves
  // the VM's capabilitySecretArn output to its value), so it's in secretEnvEntries,
  // NOT plainEnv. The per-app auth Lambdas (frontend-authorizer + auth-lambda)
  // MINT capability tokens, so they must read it — pass its secret name + grantRead.
  const capSecretEntry = secretEnvEntries.find((e) => e.key === "capabilitySecretArn");
  const capSecretName = capSecretEntry?.secretName ?? "";

  const plainEnv: Record<string, string> = Object.fromEntries(
    Object.entries(nonPolicyEnv).filter(
      ([, value]) => !(value as string).startsWith("secret://")
    )
  );


  // Cognito config (from aws/cognito package outputs via hereyaProjectEnv)
  const cognitoUserPoolId = plainEnv["userPoolId"] ?? nonPolicyEnv["userPoolId"];
  const cognitoClientId = plainEnv["userPoolClientId"] ?? nonPolicyEnv["userPoolClientId"];
  const cognitoRegion = plainEnv["awsCognitoRegion"] ?? nonPolicyEnv["awsCognitoRegion"] ?? process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";

  // -----------------------------------------------------------------------
  // Lambda naming prefix for per-app Lambdas (derived from customDomain)
  // -----------------------------------------------------------------------

  // ⚠️ The prefix also names ACCOUNT-GLOBAL things the connector creates at
  // runtime (IAM roles `<prefix>role-shared`, `<prefix>role-<o8>-<a8>`) and the
  // orphan-role sweep it deletes by. A SECONDARY pod (same account, same public
  // customDomain) must not share it, or its deploy-backend overwrites the
  // primary's shared-role policy. It takes its own OWNED host instead
  // (app-ca.dilaya.eu → `app-ca-app-`); a primary pod keeps the public one, so
  // its template is unchanged (t_rca_p1_router B2, 26/10/2026).
  const nameSource = ctx.skipGlobalResources ? ctx.originDomain : customDomain;
  const orgPrefix = nameSource
    ? nameSource.split(".")[0]
    : stack.stackName.substring(0, 20);
  if (ctx.skipGlobalResources && customDomain && orgPrefix === customDomain.split(".")[0]) {
    throw new Error(
      `originDomain (${ctx.originDomain}) must start with a label other than the public one ` +
        `(${orgPrefix}): a secondary pod's name prefix would collide with the primary's IAM roles`
    );
  }
  const appLambdaNamePrefix = `${orgPrefix}-app-`;
  ctx.appLambdaNamePrefix = appLambdaNamePrefix;
  ctx.capSecretEntry = capSecretEntry;
  ctx.capSecretName = capSecretName;
  ctx.cognitoClientId = cognitoClientId;
  ctx.cognitoRegion = cognitoRegion;
  ctx.cognitoUserPoolId = cognitoUserPoolId;
  ctx.nonPolicyEnv = nonPolicyEnv;
  ctx.plainEnv = plainEnv;
  ctx.policyEnv = policyEnv;
  ctx.secretEnvEntries = secretEnvEntries;
}