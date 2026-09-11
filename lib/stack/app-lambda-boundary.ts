import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function createAppLambdaBoundary(stack: cdk.Stack, ctx: StackContext): void {
  const { appLambdaNamePrefix, nonPolicyEnv } = ctx;

  // -----------------------------------------------------------------------
  // Per-app Lambda roles — created at RUNTIME, one per (org,app), by the
  // connector (src/app-lambda.ts createAppRole). This replaces the old single
  // shared role, which physically couldn't bake in a specific orgId, so its
  // S3 grant had to be storage-prefix-wide (a cross-tenant file gap). Now each
  // per-app Lambda gets its OWN role whose inline policy is scoped to
  // <orgId>/<app>/*. Two guardrails keep runtime role-creation safe:
  //   1. the connector may only CreateRole under `appRolePath`, and only if it
  //      attaches the PERMISSIONS BOUNDARY below (see the fn IAM grants);
  //   2. the boundary is the hard ceiling for ANY per-app role — even a bug in
  //      the inline policy can't exceed "logs + VM data routes + files-bucket
  //      S3": no IAM, no VM /admin/*, no other buckets, no Cognito, no secrets.
  // -----------------------------------------------------------------------

  const appRolePath = "/dilaya-app/";
  const vmApiId = nonPolicyEnv["dataApiUrl"]
    ? new URL(nonPolicyEnv["dataApiUrl"]).host.split(".")[0]
    : undefined;
  const appBucket = nonPolicyEnv["bucketName"];
  const appPrefix = nonPolicyEnv["s3Prefix"];

  const boundaryStatements: iam.PolicyStatement[] = [
    new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*`],
    }),
  ];
  if (vmApiId) {
    // Data routes only — NEVER /admin/* (delete-app, sync are connector-only).
    boundaryStatements.push(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: ["POST/query", "POST/batch-execute", "POST/tx/begin", "POST/tx/commit", "POST/tx/rollback", "GET/stats"].map(
          (r) => `arn:aws:execute-api:${stack.region}:${stack.account}:${vmApiId}/*/${r}`
        ),
      })
    );
  }
  if (appBucket) {
    // Ceiling = the whole files bucket/prefix; each per-app role's inline
    // policy narrows this to its own <orgId>/<app>/*.
    boundaryStatements.push(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`arn:aws:s3:::${appBucket}/${appPrefix ? appPrefix + "/" : ""}*`],
      }),
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${appBucket}`],
      })
    );
  }
  // Mail (now) + integration secrets (next milestone): a per-app frontend
  // handler can read its OWN app's Postmark server token / integration secrets
  // from SSM SecureString. CEILING = any org/app's `/mail/*` + `/secrets/*`
  // params; each per-app role's inline policy (src/app-lambda.ts
  // appRolePolicyDocument) narrows this to /dilaya/<orgId>/apps/<app>/{mail,secrets}/*.
  // No other SSM paths (never the agent/telegram/viewer-cert params).
  boundaryStatements.push(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/dilaya/*/apps/*/mail/*`,
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/dilaya/*/apps/*/secrets/*`,
      ],
    }),
    // Decrypt the SecureString value — usable ONLY through SSM (kms:ViaService),
    // same pattern as the connector fn's own ssmKmsDecrypt grant.
    new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: {
        StringEquals: { "kms:ViaService": `ssm.${stack.region}.amazonaws.com` },
      },
    })
  );
  const appLambdaBoundary = new iam.ManagedPolicy(stack, "AppLambdaBoundary", {
    description: "Permissions ceiling for per-app frontend Lambda roles (logs + VM data routes + files bucket + own-app mail/secrets SSM).",
    statements: boundaryStatements,
  });
  ctx.appLambdaBoundary = appLambdaBoundary;
  ctx.appRolePath = appRolePath;
}