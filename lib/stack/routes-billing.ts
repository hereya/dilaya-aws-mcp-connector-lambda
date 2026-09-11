import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function createBillingRoutes(stack: cdk.Stack, ctx: StackContext): void {
  const { fn, httpApi, lambdaIntegration } = ctx;
  httpApi.addRoutes({
    path: "/org-events",
    methods: [apigwv2.HttpMethod.POST],
    integration: lambdaIntegration,
  });

  // Public domain-billing read (NO JWT authorizer). dilaya.eu pulls an org's
  // REGISTERED domain names and their AWS prices from here, to invoice them
  // at cost + margin — only the connector knows a registration succeeded, and
  // only its AWS account can price a TLD. Same self-authentication as the
  // webhook above (an AS-signed RS256 assertion, verified in the connector
  // against the AS JWKS), with the `aud` bound to THIS url so an org-events
  // assertion cannot be replayed here.
  //
  // A PULL, not a push: a lost push is a domain nobody is ever charged for
  // and nothing says so, whereas a missed read is picked up by the next one.
  httpApi.addRoutes({
    path: "/billing/domain-orders",
    methods: [apigwv2.HttpMethod.GET],
    integration: lambdaIntegration,
  });

  // Public org-usage read (NO JWT authorizer). dilaya.eu pulls an org's
  // COUNTED REQUESTS for the current month, so it can warn the customer
  // before the monthly cap stops serving their sites. The counters are
  // written by the frontend authorizer into this account's state table and
  // exist nowhere else; the allowance, the owner's address and Postmark are
  // on the other side. Neither half can warn anyone alone.
  //
  // Same self-authentication as the two routes above (an AS-signed RS256
  // assertion verified against the AS JWKS), with `aud` bound to THIS url so
  // a domain-orders or org-events assertion cannot be replayed here.
  httpApi.addRoutes({
    path: "/billing/org-usage",
    methods: [apigwv2.HttpMethod.GET],
    integration: lambdaIntegration,
  });

  // Public org-domains routes (NO JWT authorizer). What the CUSTOMER SPACE
  // on dilaya.eu shows and does about the domains an org bought: who the
  // name is registered to, when it expires, whether it renews — and the two
  // gestures that make the ownership real rather than stated (stop renewing;
  // ask for the transfer code that lets the customer take the name
  // elsewhere). None of it can be served from dilaya.eu alone: the domains
  // live in THIS account, and only this side can ask the registrar.
  //
  // Same self-authentication as the routes above (an AS-signed RS256
  // assertion verified against the AS JWKS), and each `aud` is bound to its
  // OWN url — which is the point of listing three routes rather than one
  // multiplexed endpoint: an assertion minted to READ a customer's domains
  // cannot be replayed to stop their renewal or to mint their transfer code.
  httpApi.addRoutes({
    path: "/org-domains",
    methods: [apigwv2.HttpMethod.GET],
    integration: lambdaIntegration,
  });
  httpApi.addRoutes({
    path: "/org-domains/auto-renew",
    methods: [apigwv2.HttpMethod.POST],
    integration: lambdaIntegration,
  });
  // The code itself NEVER travels back to a browser or an agent: this route
  // answers dilaya.eu, which mails it to the registrant on file at the
  // registrar (an address supplied by nobody — read from the registrar), and
  // reports only that it was sent.
  httpApi.addRoutes({
    path: "/org-domains/transfer-code",
    methods: [apigwv2.HttpMethod.POST],
    integration: lambdaIntegration,
  });

  // Allow API Gateway to invoke the org Lambda on ANY route of this API.
  // HttpLambdaIntegration only grants a route-specific permission for /mcp,
  // but the org Lambda creates additional routes at runtime that target
  // itself (e.g. per-app Telegram webhooks at /{schema}/telegram/{proxy+}).
  // Without an api-scoped permission those routes return 500 (API Gateway
  // cannot invoke the Lambda), and the org Lambda cannot self-grant
  // (its lambda:AddPermission IAM is scoped to per-app function names only).
  fn.addPermission("HttpApiInvokeAll", {
    principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${httpApi.apiId}/*/*`,
  });

}