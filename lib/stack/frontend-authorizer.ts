import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { LIB_DIR } from "./constants";
import type { StackContext } from "./context";

export function createFrontendAuthorizer(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentDomain, appContentOriginSecret, appContentOriginSecretPrevious, capSecretEntry, capSecretName, cognitoRegion, fn, httpApi, memorySize, monitoredFunctions, plainEnv, policyEnv, timeout } = ctx;
  // -----------------------------------------------------------------------
  // Frontend Authorizer + Auth Lambda (for per-app Lambdas)
  // -----------------------------------------------------------------------

  // These are created at CDK time. Their IDs are passed to the org Lambda
  // so it can create per-app API Gateway routes dynamically.
  //
  // Un-guarded (F3): per-app Cognito pools are created at RUNTIME by enable-auth,
  // so there is NO deploy-time pool to gate on — the shared frontend authorizer +
  // auth Lambda are created UNCONDITIONALLY. Each resolves the per-app pool from
  // the request PATH → registry (name#<app>) → the app's `_auth_config` row
  // (SQLite, via the VM Data API). Both MINT their own capability token; they are
  // trusted deploy-package infra, not agent code. `frontendAuthorizerId` /
  // `authIntegrationId` are exported to the connector `fn` env for F3a route
  // plumbing (setSiteRoutesAuth / ensureAuthRoute).

  let frontendAuthorizerId: string | undefined;
  let authIntegrationId: string | undefined;
  // Outer-scope ref so the APP_STATE_TABLE grant (for the per-app agent-session
  // secret) can be attached after that table is created further down.
  let frontendAuthorizerRef: lambda.Function | undefined;

    // Frontend Authorizer Lambda (multi-tenant: per-app pool lookup via the
    // registry + the app's SQLite `_auth_config`; validates the Cognito ID-token
    // cookie against that pool's JWKS, plus the `dilaya_agent` HMAC session).
    const frontendAuthorizerFn = new lambda.Function(
      stack,
      "FrontendAuthorizerHandler",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(
          path.join(LIB_DIR, "frontend-authorizer")
        ),
        memorySize: 128,
        timeout: cdk.Duration.seconds(10),
        environment: {
          awsRegion: stack.region,
          COGNITO_REGION: cognitoRegion,
          dataApiUrl: plainEnv["dataApiUrl"] ?? "",
          registryTableName: plainEnv["registryTableName"] ?? "",
          capabilitySecretArn: capSecretName,
          // App-content origin lock: when set, the authorizer denies direct
          // (non-vanity-edge) requests to site/auth routes, so tenant frontends
          // answer only via <app>--<org>.<appContentDomain>, never app.dilaya.eu.
          appContentDomain: appContentDomain ?? "",
          // Un-forgeable variant: the shared secret the app-content distribution
          // stamps as `x-dilaya-origin-verify`. When present the authorizer accepts
          // it (and, transitionally, the legacy marker); empty → marker-only gate.
          appContentOriginSecret: appContentOriginSecret ?? "",
          // Rotation window: the PREVIOUS secret is also accepted while set,
          // so re-stamping the distributions causes no 403 window.
          appContentOriginSecretPrevious: appContentOriginSecretPrevious ?? "",
        },
      }
    );
    frontendAuthorizerRef = frontendAuthorizerFn;
    monitoredFunctions.push({ label: "FrontendAuthorizer", fn: frontendAuthorizerFn });

    // Apply the SQLite-data package IAM (Data API execute-api + registry
    // GetItem + capability-secret GetSecretValue) + S3 read so the authorizer
    // can resolve the app, read `_auth_config`, and mint capability tokens.
    for (const [, value] of Object.entries(policyEnv)) {
      const policy = JSON.parse(value as string);
      for (const statement of policy.Statement) {
        frontendAuthorizerFn.addToRolePolicy(
          iam.PolicyStatement.fromJson(statement)
        );
      }
    }
    // Read the capability signing secret so the authorizer can mint tokens.
    if (capSecretEntry) capSecretEntry.secret.grantRead(frontendAuthorizerFn);

    // Grant API Gateway permission to invoke the frontend authorizer
    frontendAuthorizerFn.addPermission("ApiGwAuthorizerInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${httpApi.apiId}/*`,
    });

    // Frontend Authorizer as L1 construct (to get authorizer ID)
    const frontendAuthorizerCfn = new apigwv2.CfnAuthorizer(
      stack,
      "FrontendAuthorizerCfn",
      {
        apiId: httpApi.apiId,
        authorizerType: "REQUEST",
        authorizerUri: `arn:aws:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${frontendAuthorizerFn.functionArn}/invocations`,
        authorizerPayloadFormatVersion: "2.0",
        enableSimpleResponses: true,
        authorizerResultTtlInSeconds: 0,
        identitySource: [] as string[], // empty = always invoke (supports public endpoints)
        name: "FrontendAuthorizerV2",
      }
    );
    frontendAuthorizerId = frontendAuthorizerCfn.ref;

    // Auth Lambda (login / send-otp / verify / logout). Multi-tenant: extracts
    // orgId + app from the path (`/o/{orgId}/{app}/auth/...`), resolves the app
    // via the registry, reads the per-app pool client + from_email from the
    // app's SQLite `_auth_config`, the allowlist from `_user_access`, and the
  ctx.authIntegrationId = authIntegrationId;
  ctx.frontendAuthorizerId = frontendAuthorizerId;
  ctx.frontendAuthorizerRef = frontendAuthorizerRef;
}