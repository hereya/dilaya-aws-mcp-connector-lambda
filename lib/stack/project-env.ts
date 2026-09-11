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

  const orgPrefix = customDomain
    ? customDomain.split(".")[0]
    : stack.stackName.substring(0, 20);
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