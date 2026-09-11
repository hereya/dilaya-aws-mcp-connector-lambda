import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as path from "path";
import { LIB_DIR } from "./constants";
import type { StackContext } from "./context";

export function createMcpAuthorizer(stack: cdk.Stack, ctx: StackContext): void {
  const { expectedAudience, fn, memorySize, monitoredFunctions, oauthServerUrl, organizationId, timeout } = ctx;
  // -----------------------------------------------------------------------
  // MCP OAuth Authorizer Lambda
  // -----------------------------------------------------------------------

  const authorizerFn = new lambda.Function(stack, "AuthorizerHandler", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset(path.join(LIB_DIR, "authorizer")),
    memorySize: 128,
    timeout: cdk.Duration.seconds(10),
    environment: {
      OAUTH_SERVER_URL: oauthServerUrl,
      BOUND_ORG_ID: organizationId, // empty ⇒ multi-tenant org_ids mode
      EXPECTED_AUDIENCE: expectedAudience,
    },
  });
  monitoredFunctions.push({ label: "McpAuthorizer", fn: authorizerFn });

  const httpAuthorizer = new authorizers.HttpLambdaAuthorizer(
    "HereyaAuthorizer",
    authorizerFn,
    {
      responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: cdk.Duration.minutes(5),
    }
  );
  ctx.httpAuthorizer = httpAuthorizer;
}