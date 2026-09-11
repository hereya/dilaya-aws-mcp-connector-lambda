import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StackContext } from "./context";

export function createRoutes(stack: cdk.Stack, ctx: StackContext): void {
  const { httpApi, httpAuthorizer, lambdaIntegration, prmLambda } = ctx;

  httpApi.addRoutes({
    path: "/.well-known/oauth-protected-resource",
    methods: [apigwv2.HttpMethod.GET],
    integration: new integrations.HttpLambdaIntegration(
      "PrmIntegration",
      prmLambda
    ),
  });

  // MCP route (existing)
  httpApi.addRoutes({
    path: "/mcp",
    methods: [apigwv2.HttpMethod.POST],
    integration: lambdaIntegration,
    authorizer: httpAuthorizer,
  });

  // Public agent-loop routes (NO JWT authorizer). The multi-tenant connector's
  // dumb local poller (the `dilaya` CLI) exchanges a single-use setup token and
  // polls "is there work?" here; auth is the poll token, verified inside the
  // Lambda (agent-handler.ts), not a JWT. Org + app live in the PATH because
  // these calls carry no token to read the org set from. In the legacy per-org
  // app these routes were created dynamically by the org Lambda; here they are
  // STATIC — one deployment serves every org — so no runtime route creation and
  // no ApiGatewayV2 IAM on the connector role. A single catch-all covers both
  // /agent/token (POST) and /agent/poll (GET); the handler validates the exact
  // sub-path and 404s anything else. Invoke permission is the api-wide
  // `HttpApiInvokeAll` grant below.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/agent/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public Telegram routes (NO JWT authorizer). Telegram's servers POST inbound
  // updates to /o/{orgId}/{app}/telegram/webhook (authenticated by the
  // per-app secret-token header, checked in the Lambda), and the user opens
  // /o/{orgId}/{app}/telegram/setup to enter the bot token out of band (a
  // signed single-use link). Org + app live in the PATH; these are STATIC (one
  // deployment serves every org) — no runtime route creation. Handler
  // validates the exact sub-path. Invoke permission is the api-wide
  // HttpApiInvokeAll grant below.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/telegram/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public integration-secret route (NO JWT authorizer). The USER opens
  // /o/{orgId}/{app}/secrets/setup (a signed single-use link) to enter a
  // 3rd-party API key out of band; the connector Lambda writes it straight to
  // SSM SecureString (never into MCP). Org + app live in the PATH; STATIC (one
  // deployment serves every org) — no runtime route creation. Handler validates
  // the exact sub-path. Invoke permission is the api-wide HttpApiInvokeAll grant
  // below; the connector role's existing /dilaya/*/apps/* SSM Put/Delete grant
  // covers the /secrets/<name> write path (no IAM delta needed).
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/secrets/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public domain-purchase route (NO JWT authorizer). The USER opens
  // /o/{orgId}/{app}/domains/register (a signed single-use link minted by
  // register-domain) to enter the registrant contacts out of band; the
  // connector Lambda passes them straight to Route 53 Domains (never into
  // MCP, never stored). STATIC like the other public routes; the handler
  // validates the exact sub-path and answers 404 when the domainPurchase
  // feature is off — the route itself is unconditional, matching the
  // secrets/telegram pattern. Invoke permission is the api-wide
  // HttpApiInvokeAll grant below.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/domains/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public MCP-connection routes (NO JWT authorizer). Two surfaces:
  //   /mcp-connections/{consent,callback} — the org-level OAuth consent flow
  //     for OUTBOUND connections to external MCP servers: `consent` is a
  //     signed single-use link (org rides in the query + HMAC token, no org
  //     path segment) that 302s to the target server's authorization page;
  //     `callback` is the FIXED redirect URI registered via DCR (it must be
  //     stable across orgs, hence top-level). Tokens land in SSM SecureString
  //     /dilaya/<orgId>/mcp/* — see the SSM grant below.
  //   /o/{orgId}/{app}/mcp/{proxy+} — the gateway a per-app backend Lambda
  //     POSTs to to call a GRANTED tool on a connected server. Auth is the
  //     app's DILAYA_CAPABILITY token (HMAC-verified in the connector Lambda,
  //     appId cross-checked against the path), allowlist enforced fail-closed
  //     server-side. STATIC like the other public routes; the handler
  //     validates the exact sub-path. Invoke permission is the api-wide
  //     HttpApiInvokeAll grant below.
  httpApi.addRoutes({
    path: "/mcp-connections/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/mcp/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public app-cron gateway (NO JWT authorizer). A per-app backend Lambda
  // manages ITS OWN schedules (one-shot reminders, recurring jobs) here,
  // authenticated by its DILAYA_CAPABILITY token — same self-auth model as
  // the MCP gateway above. The connector enforces app identity + owns all
  // Scheduler credentials; app Lambdas get NO scheduler IAM.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/cron/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public app-LLM gateway (NO JWT authorizer). A per-app backend Lambda
  // runs completions/embeddings on the platform OpenAI key here (runtime
  // `llm` helper), authenticated by its DILAYA_CAPABILITY token — same
  // self-auth model as the MCP/cron gateways. The connector enforces the
  // per-org opt-in + monthly budget and holds the key; app Lambdas carry
  // NO provider credentials and get no new IAM.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/llm/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public app-mail gateway (NO JWT authorizer). A per-app backend Lambda
  // sends its transactional email here (runtime `mail.send`) instead of
  // calling Postmark itself — same DILAYA_CAPABILITY self-auth as the
  // MCP/cron/LLM gateways. Two reasons it moved: the org's monthly email
  // allowance is enforced connector-side (a cap the app could bypass is not
  // a cap), and the per-app Postmark token stops being something an app
  // Lambda has to read. The old direct path still works, so a Lambda still
  // on the previous runtime layer keeps sending while the layer propagates.
  httpApi.addRoutes({
    path: "/o/{orgId}/{app}/mail/{proxy+}",
    methods: [apigwv2.HttpMethod.ANY],
    integration: lambdaIntegration,
  });

  // Public org-events webhook (NO JWT authorizer). dilaya.eu (the connect
  // AS) POSTs here on each org modification to invalidate the connector's
  // org-info cache for that org. Self-authenticated in the connector: the
  // request carries a short-lived RS256 assertion signed by the AS's own
  // KMS key, verified against the AS JWKS — the same trust root this
  // stack's JWT authorizer uses. The custom domain maps straight to API
  // Gateway (no CloudFront hop), so no header-forwarding concerns.
}