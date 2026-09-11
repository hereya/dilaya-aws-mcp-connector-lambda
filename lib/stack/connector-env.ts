import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "./context";

export function setConnectorEnv(stack: cdk.Stack, ctx: StackContext): void {
  const { appLambdaBoundary, appLambdaNamePrefix, appRolePath, authIntegrationId, cognitoRegion, fn, frontendAuthorizerId, httpApi, organizationId, runtimeLayer, triggerArns } = ctx;
  // -----------------------------------------------------------------------
  // Org Lambda: environment variables for per-app Lambda management
  // -----------------------------------------------------------------------

  fn.addEnvironment("APP_LAMBDA_ROLE_PATH", appRolePath);
  fn.addEnvironment("APP_LAMBDA_PERMISSIONS_BOUNDARY_ARN", appLambdaBoundary.managedPolicyArn);
  fn.addEnvironment("APP_LAMBDA_NAME_PREFIX", appLambdaNamePrefix);
  if (runtimeLayer) {
    fn.addEnvironment("APP_LAMBDA_LAYER_ARN", runtimeLayer.layerVersionArn);
  }
  fn.addEnvironment("HTTP_API_ID", httpApi.apiId);
  fn.addEnvironment("AWS_ACCOUNT_ID", stack.account);
  fn.addEnvironment("ORGANIZATION_ID", organizationId);
  fn.addEnvironment("AGENT_SECRET_SSM_PREFIX", `/hereya/${organizationId}/apps`);
  fn.addEnvironment("COGNITO_TRIGGER_LAMBDA_ARNS", triggerArns.join(","));
  fn.addEnvironment("awsRegion", stack.region);
  // Cognito region for enable-auth (app-auth.ts reads COGNITO_REGION ?? awsRegion).
  fn.addEnvironment("COGNITO_REGION", cognitoRegion);

  if (frontendAuthorizerId) {
    fn.addEnvironment("FRONTEND_AUTHORIZER_ID", frontendAuthorizerId);
  }
  if (authIntegrationId) {
    fn.addEnvironment("AUTH_INTEGRATION_ID", authIntegrationId);
  }
}