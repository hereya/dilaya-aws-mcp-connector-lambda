import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "./context";

export function setConnectorEnv(stack: cdk.Stack, ctx: StackContext): void {
  const { appLambdaBoundary, appLambdaNamePrefix, appRolePath, authIntegrationId, cognitoRegion, fn, frontendAuthorizerId, httpApi, organizationId, runtimeLayer, triggerNames } = ctx;
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
  // NAMES, not ARNs (0.1.82). Lambda caps the whole environment at 4 KB, and on
  // 2026-09-21 the release that pinned dilaya/aws-agentcore-harness measured 4152
  // bytes: UPDATE_FAILED on the Handler, stack rolled back, release lost. This was
  // the biggest variable by far — 470 bytes, the same 53-character
  // `arn:aws:lambda:<region>:<account>:function:` written four times, which the
  // connector can rebuild from `awsRegion` + `AWS_ACCOUNT_ID` below (it does since
  // 0.1.303, and still reads a full ARN). The variable keeps its name: renaming it
  // would need both halves to land in lockstep for no gain.
  fn.addEnvironment("COGNITO_TRIGGER_LAMBDA_ARNS", triggerNames.join(","));
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