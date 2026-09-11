import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { LIB_DIR } from "./constants";
import type { StackContext } from "./context";

export function createAuthLambda(stack: cdk.Stack, ctx: StackContext): void {
  const { capSecretEntry, capSecretName, cognitoRegion, customDomain, fn, httpApi, memorySize, monitoredFunctions, plainEnv, policyEnv, timeout } = ctx;
  // Postmark server token from SSM `/dilaya/<orgId>/apps/<app>/auth/...`.
  const authLambdaFn = new lambda.Function(stack, "AuthLambdaHandler", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset(path.join(LIB_DIR, "auth-lambda")),
    memorySize: 128,
    timeout: cdk.Duration.seconds(15),
    environment: {
      awsRegion: stack.region,
      COGNITO_REGION: cognitoRegion,
      dataApiUrl: plainEnv["dataApiUrl"] ?? "",
      registryTableName: plainEnv["registryTableName"] ?? "",
      capabilitySecretArn: capSecretName,
      customDomain: customDomain ?? "",
      bucketName: plainEnv["bucketName"] ?? "",
      s3Prefix: plainEnv["s3Prefix"] ?? "",
    },
  });

  // Apply the SQLite-data package IAM (Data API + registry + capability
  // secret) + S3 read so the auth Lambda can resolve the app, read
  // `_auth_config`/`_user_access`, and mint capability tokens.
  for (const [, value] of Object.entries(policyEnv)) {
    const policy = JSON.parse(value as string);
    for (const statement of policy.Statement) {
      authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
    }
  }
  // Read the capability signing secret so the auth Lambda can mint tokens.
  if (capSecretEntry) capSecretEntry.secret.grantRead(authLambdaFn);
  monitoredFunctions.push({ label: "AuthLambda", fn: authLambdaFn });

  // Read per-app Postmark server tokens from SSM SecureString. Multi-tenant:
  // one auth Lambda serves every org, so it needs /dilaya/<anyOrg>/apps/* —
  // per-org isolation is enforced in code (the SSM path is always built from
  // the path-derived orgId, never caller input). Mirrors the connector fn's
  // agent/telegram SSM grant.
  authLambdaFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/dilaya/*/apps/*`,
      ],
    })
  );
  authLambdaFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "kms:ViaService": `ssm.${stack.region}.amazonaws.com`,
        },
      },
    })
  );

  // Allow InitiateAuth / RespondToAuthChallenge against any per-app pool
  // in this account (pool ARNs are created at runtime by enable-auth).
  authLambdaFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cognito-idp:InitiateAuth",
        "cognito-idp:RespondToAuthChallenge",
      ],
      resources: ["*"],
    })
  );

  // Grant API Gateway permission to invoke auth Lambda
  authLambdaFn.addPermission("ApiGwInvoke", {
    principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${httpApi.apiId}/*/*`,
  });

  // Auth Lambda integration as L1 construct (to get integration ID)
  const authIntegrationCfn = new apigwv2.CfnIntegration(
    stack,
    "AuthIntegrationCfn",
    {
      apiId: httpApi.apiId,
      integrationType: "AWS_PROXY",
      integrationUri: authLambdaFn.functionArn,
      payloadFormatVersion: "2.0",
    }
  );
  ctx.authIntegrationId = authIntegrationCfn.ref;
}