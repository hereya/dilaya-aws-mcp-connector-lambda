import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";
import type { StackContext } from "./context";

export function configureStageSettings(stack: cdk.Stack, ctx: StackContext): void {
  const { cfnDefaultStage, httpApi } = ctx;
  // explicitly: whichever way it merges, they carry exactly these numbers.
  const THROTTLING_RATE_LIMIT = 100;
  const THROTTLING_BURST_LIMIT = 200;

  // Per-route `5xx`/`4xx`/`Count`/`Latency` — ON for the routes this stack
  // defines, OFF by default (2026-08-29).
  //
  // It was on for everything, because with only the API-level 5xx metric the
  // 2026-08-05 burst was unattributable: 9 failures, no way to say whether
  // they were /mcp or a tenant site route. That attribution is still needed
  // — but it is no longer this property that provides it, and this property
  // is the one that costs money per tenant.
  //
  // API Gateway emits SIX metrics per route (`Count`, `Latency`,
  // `IntegrationLatency`, `DataProcessed`, `4xx`, `5xx`), each billed as a
  // CUSTOM metric at $0.30/month, prorated by the hours the route sees
  // traffic. `set-app-host` creates one or two routes per app frontend AT
  // RUNTIME, and each inherited this default — so the monitoring bill grew
  // with the customer list, invisibly. Measured on 2026-08-29: $9.18/month
  // of route metrics, $4.24 of it the tenant `…/site…` and `…/auth…` routes,
  // against $3.50 for all 35 alarms put together.
  //
  // What replaces it for tenant routes: the access log above already writes
  // `routeKey` + `status` + `integrationStatus` for EVERY request, over the
  // same two weeks the sweep reads — the finer signal, not the coarser one.
  // And nothing alarms on these metrics: the platform-vs-tenant 5xx split is
  // built from the two log metric filters below, not from them.
  //
  // So the cost is now bounded by a route count this file controls, instead
  // of by how many customers have a frontend.
  cfnDefaultStage.defaultRouteSettings = {
    ...(cfnDefaultStage.defaultRouteSettings as
      | apigwv2.CfnStage.RouteSettingsProperty
      | undefined),
    detailedMetricsEnabled: false,
    // --- The last-resort ceiling (t_09669ba18d5e) ----------------------
    // The per-IP guard in the frontend authorizer is the TARGETED defense:
    // it cuts the one address that is looping and nobody else. This is the
    // blunt one underneath it, and the two are not interchangeable.
    //
    // It is the only layer here that can answer a real **429**: an authorizer
    // does not choose its status code (a refusal is always 403), while the
    // gateway throttles natively and says "Too Many Requests" properly. But
    // it is GLOBAL — one runaway would eat the shared budget and throttle
    // every other tenant, and `/mcp` with them. So it must never be the thing
    // that fires in a normal incident; it exists for the case the targeted
    // guard cannot see (many addresses at once) or is itself broken.
    //
    // Hence a threshold with an absurd amount of headroom, not a tuned one:
    // real traffic is 500-2300 requests per DAY (~0.03/s average) and the
    // 2026-08-27 runaway peaked at 19/s. 100/s sustained with a 200 burst is
    // >5x the worst second ever recorded on this gateway, so nothing
    // legitimate — and not even a repeat of that loop — can reach it.
    throttlingRateLimit: THROTTLING_RATE_LIMIT,
    throttlingBurstLimit: THROTTLING_BURST_LIMIT,
  };

  // The routes THIS STACK defines keep their detail. Derived by walking the
  // construct tree rather than repeating a list: a route added to this file
  // tomorrow is covered on the day it is added, and a route created at
  // runtime — the ones that multiply — is not, because it is not here.
  cfnDefaultStage.routeSettings = cdk.Lazy.any({
    produce: () =>
      Object.fromEntries(
        httpApi.node
          .findAll()
          .filter(
            (c): c is apigwv2.CfnRoute => c instanceof apigwv2.CfnRoute
          )
          .map((route) => [
            route.routeKey,
            {
              DetailedMetricsEnabled: true,
              ThrottlingRateLimit: THROTTLING_RATE_LIMIT,
              ThrottlingBurstLimit: THROTTLING_BURST_LIMIT,
            },
          ])
      ),
  });

  // …AND THE STAGE MUST BE WRITTEN AFTER THE ROUTES IT NAMES.
  //
  // What the settings above express is invisible to CloudFormation: the keys
  // are plain STRINGS, so nothing in the template says the stage depends on
  // the routes. CloudFormation is therefore free to update the stage first —
  // and it does. API Gateway then refuses the whole update:
  //
  //   Unable to find Route by key POST /org-domains/auto-renew
  //   within the provided RouteSettings (404)
  //
  // That is not a hypothesis: it is what broke the 0.1.216 deploy of
  // app.dilaya.eu on 2026-09-07, the first time a ROUTE was added since these
  // per-route settings existed. Worse, the ROLLBACK failed on the mirror
  // image of the same quirk (removing the settings of a route that does not
  // exist is also a 404), leaving a production stack stuck in
  // UPDATE_ROLLBACK_FAILED — traffic fine, every future deploy blocked.
  //
  // An Aspect rather than a loop here: routes are added throughout this
  // constructor (and some in helpers below), so a dependency wired at this
  // line would cover only the routes that happen to exist at this line — the
  // ones added later, i.e. exactly the new ones this protects, would be
  // missed. The aspect runs once the whole tree is built.
  cdk.Aspects.of(stack).add({
    visit(node: Construct) {
      if (node instanceof apigwv2.CfnRoute) {
        // `node.addDependency`, not the deprecated `CfnResource.addDependency`.
        cfnDefaultStage.node.addDependency(node);
      }
    },
  });

}