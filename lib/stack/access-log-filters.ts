import * as cdk from "aws-cdk-lib/core";
import * as logs from "aws-cdk-lib/aws-logs";
import type { StackContext } from "./context";

export function createAccessLogFilters(stack: cdk.Stack, ctx: StackContext): void {
  const { accessLogGroup } = ctx;
  // --- Whose 5xx is it? (2026-08-20 sweep finding) -----------------------
  // The API-level `AWS/ApiGateway 5xx` metric counts every 5xx on this
  // gateway, which is SHARED by every tenant site and backend. Over 30 days
  // of alarm history exactly one alarm ever fired for real — the 5xx one, 4
  // times on 2026-08-14 — and it was not us: the 10 requests behind it all
  // carried `int=200` on `…/komlaba/site-stg/…`, i.e. a client's
  // PRE-PRODUCTION site returning 500 on two of its own routes. Nothing of
  // ours had misbehaved. An alarm that cries wolf for someone else's bug is
  // how the only real-time alert this platform has gets ignored, and a
  // genuine failure of ours would have looked exactly the same.
  //
  // The discriminant is already written down in the access log, twice over:
  //   * `integrationStatus = 200` — the integration ANSWERED normally, so the
  //     5xx is the payload it chose to return, not a gateway fault;
  //   * the route key — tenant `…/site…` routes integrate DIRECTLY with the
  //     app's own `app-app-*` Lambda, and they are the only routes carrying
  //     `/site`. Every platform route is `/mcp`, `/mcp-connections`,
  //     `/org-events`, `/billing/…`, `/.well-known/…`, the connector's own
  //     `…/auth/…`, or `/o/{orgId}/{app}/{agent,telegram,secrets,domains,
  //     cron,llm,mail}/…`.
  // BOTH together — and only both — mean "the client's app answered 500".
  // Everything else is ours, including our own handler returning a 500 with
  // `int=200`: filtering on `integrationStatus` alone would have traded a
  // noisy alarm for a blind one.
  //
  // Two filters over the SAME log events, subtracted at the alarm. Deriving
  // both from one stream is deliberate — pairing a log-derived count with the
  // gateway's own metric would let ingestion skew push one hit into the next
  // period and invent a difference out of nothing.
  const httpApi5xxAllFilter = new logs.MetricFilter(
    stack,
    "HttpApi5xxAllFilter",
    {
      logGroup: accessLogGroup,
      metricNamespace: "Dilaya/Connector",
      metricName: "HttpApi5xx",
      // Access-log values are JSON *strings* (`"status":"500"`), so this is a
      // wildcard string match — a numeric comparison would match nothing.
      filterPattern: logs.FilterPattern.literal('{ $.status = "5*" }'),
      metricValue: "1",
      // Without a default, a period with no match has no datapoint at all and
      // `total - tenantApp` is DROPPED for that period rather than evaluated
      // — which would silently disarm the alarm below in exactly the case it
      // exists for (a platform 5xx in a period with no tenant 5xx).
      defaultValue: 0,
    }
  );
  // Not alarmed on here, on purpose: a client's own 500 is the client's to
  // fix, and alerting the org that owns the app is its own problem. What this
  // metric does is make that population countable instead of invisible.
  const httpApi5xxTenantAppFilter = new logs.MetricFilter(
    stack,
    "HttpApi5xxTenantAppFilter",
    {
      logGroup: accessLogGroup,
      metricNamespace: "Dilaya/Connector",
      metricName: "HttpApi5xxTenantApp",
      filterPattern: logs.FilterPattern.literal(
        '{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }'
      ),
      metricValue: "1",
      defaultValue: 0,
    }
  );

  ctx.httpApi5xxAllFilter = httpApi5xxAllFilter;
  ctx.httpApi5xxTenantAppFilter = httpApi5xxTenantAppFilter;
}