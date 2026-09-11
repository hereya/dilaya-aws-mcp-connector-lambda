import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function grantAppLambdaManagement(stack: cdk.Stack, ctx: StackContext): void {
  const { appLambdaArnPattern, appLambdaBoundary, appLambdaNamePrefix, appRolePath, fn, httpApi, runtimeLayer } = ctx;

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:InvokeFunction",
      ],
      resources: [appLambdaArnPattern],
    })
  );

  // Per-app log-group retention. A tenant Lambda's log group is created by the
  // RUNTIME on first invocation, not by this stack, so it is born with AWS's
  // "never expire" default while every group declared here gets 731 days —
  // tenant handlers were keeping their users' log lines forever. The connector
  // now creates the group itself and stamps an expiry on it (365 days, matching
  // the 12-month conservation commitment) at create AND at every redeploy, which
  // also back-fills apps provisioned before this shipped. Scoped to the tenant
  // name pattern only: this grant can never touch a platform log group.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:PutRetentionPolicy"],
      resources: [
        `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*`,
        `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*:*`,
      ],
    })
  );

  // Lambda layer access (needed when creating per-app Lambdas with layers)
  if (runtimeLayer) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:GetLayerVersion"],
        resources: [runtimeLayer.layerVersionArn],
      })
    );
  }

  // API Gateway route management
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "apigateway:POST",
        "apigateway:DELETE",
        "apigateway:GET",
        "apigateway:PATCH",
      ],
      resources: [
        `arn:aws:apigateway:${stack.region}::/apis/${httpApi.apiId}/*`,
      ],
    })
  );

  // Per-app role management. The connector creates/tears down one IAM role per
  // (org,app) — but ONLY under `appRolePath`, and CreateRole is CONDITIONED on
  // attaching the permissions boundary, so it can never mint an unbounded or
  // out-of-path role (no privilege escalation from this grant).
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:CreateRole"],
      resources: [`arn:aws:iam::${stack.account}:role${appRolePath}*`],
      conditions: { StringEquals: { "iam:PermissionsBoundary": appLambdaBoundary.managedPolicyArn } },
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:TagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:GetRole"],
      resources: [`arn:aws:iam::${stack.account}:role${appRolePath}*`],
    })
  );
  // Pass a per-app role to Lambda only (never to any other service/principal).
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${stack.account}:role${appRolePath}*`],
      conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    })
  );
}