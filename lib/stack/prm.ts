import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StackContext } from "./context";
import { OPENAI_APPS_CHALLENGE_PATH, OPENAI_APPS_CHALLENGE_TOKEN } from "./openai-challenge";

export function createPrmLambda(stack: cdk.Stack, ctx: StackContext): void {
  const { customDomain, fn, httpApi, memorySize, monitoredFunctions, oauthServerUrl, organizationId, timeout } = ctx;
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "LambdaIntegration",
      fn
    );

    // Compute service URL for PRM (custom domain or API endpoint)
    const serviceUrl = customDomain
      ? `https://${customDomain}`
      : httpApi.apiEndpoint;

    // -----------------------------------------------------------------------
    // Protected Resource Metadata (RFC 9728)
    // -----------------------------------------------------------------------

    const prmLambda = new lambda.Function(stack, "PrmHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => (event && event.rawPath === process.env.OPENAI_APPS_CHALLENGE_PATH) ? {
          // OpenAI plugin portal domain verification: the token, verbatim.
          statusCode: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          body: process.env.OPENAI_APPS_CHALLENGE,
        } : ({
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            resource: process.env.SERVICE_URL + "/mcp",
            // Multi-tenant: point at the single-URL connect AS issuer
            // (OAUTH_SERVER_URL = <base>/oauth/connect). Legacy per-org mode
            // (ORGANIZATION_ID set) keeps the old <base>/oauth/<orgId> shape.
            authorization_servers: [
              process.env.ORGANIZATION_ID
                ? process.env.OAUTH_SERVER_URL + "/oauth/" + process.env.ORGANIZATION_ID
                : process.env.OAUTH_SERVER_URL,
            ],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp:access"],
          }),
        });
      `),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: {
        SERVICE_URL: serviceUrl,
        OAUTH_SERVER_URL: oauthServerUrl,
        ORGANIZATION_ID: organizationId,
        OPENAI_APPS_CHALLENGE: OPENAI_APPS_CHALLENGE_TOKEN,
        OPENAI_APPS_CHALLENGE_PATH,
      },
    });
    monitoredFunctions.push({ label: "Prm", fn: prmLambda });
  ctx.lambdaIntegration = lambdaIntegration;
  ctx.prmLambda = prmLambda;
}