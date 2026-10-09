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

  // The PLUGIN host’s authorizer (t_dir_401_www_auth, 09/10/2026): the SAME
  // function, bound to `POST /` on mcp.<zone> only (routes.ts). With the
  // Authorization header as identity source, a request WITHOUT it never reaches
  // the function: the gateway answers its own bare 401 (no WWW-Authenticate),
  // and the ChatGPT chat runtime — which probes exactly like that — gives up with
  // « reconnect Dilaya » (5 probes on 09/10, 8 on 05/10, never a success). So
  // this one has NO identity source (always invoked, the frontend authorizer’s
  // proven shape) and NO cache (the gateway caches only on identity sources):
  // every call on the plugin host runs the function (~ms, JWKS cached 1 h),
  // and a token-less probe comes back as `refusal: probe` for the connector’s
  // 401 + WWW-Authenticate. `/mcp` keeps the cached, header-keyed authorizer
  // above byte for byte. Materialized only when a route binds it.
  ctx.mcpHostAuthorizer = new authorizers.HttpLambdaAuthorizer(
    "McpHostAuthorizer",
    authorizerFn,
    {
      responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
      identitySource: [],
      resultsCacheTtl: cdk.Duration.seconds(0),
    }
  );
}