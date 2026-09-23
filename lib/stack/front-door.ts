import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

/**
 * The FRONT DOOR (t_app_routing_o1, option C): five static routes for every
 * app's site, staging site and auth tree, integrated to the frontend
 * authorizer's own function, which authorizes then invokes the app's Lambda
 * itself (lib/frontend-authorizer/front-door.js). Replaces one integration +
 * 2-3 routes per app backend — the route count no longer grows with apps.
 *
 * No authorizer on these routes: the function IS the authorizer, and runs it
 * first. The legacy literal per-app routes win while they exist (API Gateway
 * picks the most specific route), so this lands with zero behaviour change.
 */
export const FRONT_DOOR_ROUTE_KEYS = [
  "ANY /o/{orgId}/{app}/site",
  "ANY /o/{orgId}/{app}/site/{proxy+}",
  "ANY /o/{orgId}/{app}/site-stg",
  "ANY /o/{orgId}/{app}/site-stg/{proxy+}",
  "ANY /o/{orgId}/{app}/auth/{proxy+}",
];

export function createFrontDoor(stack: cdk.Stack, ctx: StackContext): void {
  const front = ctx.frontendAuthorizerRef;
  const auth = ctx.authLambdaFn;
  if (!front || !auth) return;

  front.addEnvironment("AUTH_FUNCTION_NAME", auth.functionName);
  front.addEnvironment("APP_LAMBDA_NAME_PREFIX", ctx.appLambdaNamePrefix);
  front.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      // Tenant app backends (prod + `-stg`) and the shared auth Lambda — nothing else.
      resources: [ctx.appLambdaArnPattern, auth.functionArn],
    })
  );

  // API Gateway may already invoke this function (its authorizer permission is
  // scoped to `<apiId>/*`, which covers integration calls too).
  const integration = new apigwv2.CfnIntegration(stack, "FrontDoorIntegration", {
    apiId: ctx.httpApi.apiId,
    integrationType: "AWS_PROXY",
    integrationUri: front.functionArn,
    payloadFormatVersion: "2.0",
  });
  FRONT_DOOR_ROUTE_KEYS.forEach((routeKey, i) => {
    new apigwv2.CfnRoute(stack, `FrontDoorRoute${i}`, {
      apiId: ctx.httpApi.apiId,
      routeKey,
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
  });

  // Tells the connector it may stop creating per-app routes.
  ctx.fn.addEnvironment("FRONT_DOOR_ROUTES", "1");
}
