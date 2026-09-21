import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import type { StackContext } from "../context";

/** Refusals on `/mcp` over the window that ring the alarm. */
export const MCP_REFUSALS_THRESHOLD = 5;
export const MCP_REFUSALS_WINDOW_MINUTES = 15;

export function createMcpRefusalsAlarm(stack: cdk.Stack, ctx: StackContext): void {
  const { accessLogGroup, alertOn } = ctx;
  // --- The product's front door, refused (t_mcp_403_no_alarm) -------------
  // 2026-09-21: a landing deploy of ours broke the token refresh of every
  // ORDINARY member. `/mcp` answered 403 to almost everyone from 12:17Z to
  // 14:54Z — 188 refusals, whole 5-min windows at 10/10 — and all 37 alarms
  // stayed green: a refusal is not an error, not a 5xx, not a throttle. The
  // authorizer did its job perfectly, which is exactly why nothing rang.
  //
  // Counted on the ACCESS LOG, not in the authorizer: the gateway caches a
  // refusal for 5 min, so a client retrying in a loop is refused without the
  // authorizer ever running. The access log sees every one of them.
  //
  // The threshold is a measurement, not a guess: over the 7 days before the
  // incident, `403 POST /mcp` = ZERO (23 530 × 200). A client whose token
  // merely expired refreshes BEFORE calling; a 403 here means a client that
  // cannot get a token any more. 5 in 15 min would have rung at ~12:25Z,
  // 2 h 30 before anyone noticed. No ratio term on purpose: at 2 requests in
  // a window a share of 200s means nothing, and the count alone had no false
  // positive in a week.
  const mcp403Filter = new logs.MetricFilter(stack, "Mcp403Filter", {
    logGroup: accessLogGroup,
    metricNamespace: "Dilaya/Connector",
    metricName: "Mcp403",
    // `path`, not `routeKey`: the route is `POST /mcp` today, and a refusal
    // must keep counting if it ever moves under a proxy route.
    filterPattern: logs.FilterPattern.literal('{ $.status = "403" && $.path = "/mcp" }'),
    metricValue: "1",
    defaultValue: 0,
  });

  alertOn(
    new cloudwatch.Alarm(stack, "McpRefusalsAlarm", {
      metric: mcp403Filter.metric({
        period: cdk.Duration.minutes(MCP_REFUSALS_WINDOW_MINUTES),
        statistic: "Sum",
      }),
      threshold: MCP_REFUSALS_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        `Dilaya connector: ${MCP_REFUSALS_THRESHOLD}+ requests REFUSED (403) on /mcp in ` +
        `${MCP_REFUSALS_WINDOW_MINUTES} min — baseline is zero. Clients can no longer get or refresh a ` +
        "token: FIRST suspect our own last deploy of the OAuth AS (dilaya.eu /oauth/connect/token — read " +
        "its `connect_token_refused` lines) or of this authorizer. WHY each one was refused: the " +
        "McpAuthorizer log group, lines `mcp_authorizer_refused` (`reason`: expired, bad_signature, " +
        "issuer_mismatch, no_org_ids, audience_mismatch, jwks_unavailable…). A killed refresh chain " +
        "does NOT heal alone: those users must reconnect Dilaya in their client.",
    })
  );
}
