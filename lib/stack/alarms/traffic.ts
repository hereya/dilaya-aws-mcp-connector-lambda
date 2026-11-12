import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

/**
 * Frontend authorizer invocations per hour at which the volume alarm fires.
 * The ONE place the number lives — the alarm, its description and the test
 * that pins it all read it from here.
 */
export const FRONTEND_AUTHORIZER_VOLUME_THRESHOLD = 8000;

export function createTrafficAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, frontendAuthorizerRef, httpApi5xxTenantAppFilter } = ctx;
  // --- Volume, which every alarm above is structurally blind to ----------
  // Every instrument in this stack counts FAILURES. On 2026-08-27 a single
  // browser called one tenant route 17 386 times in under two hours — 10 to
  // 19 requests per second, sustained, from one residential IP — and not one
  // of them fired, because every single request answered HTTP 200. A runaway
  // `setInterval` (or a re-triggering effect) in a tenant's own page is not
  // an error anywhere: Lambda `Errors` 0, gateway 5xx 0, CloudFront
  // `5xxErrorRate` 0 %, the databases VM heartbeat a flat 60/60. That one
  // page produced ~70 % of the connector's traffic for the day, and the
  // only witness was the invocation COUNT — a number nobody reads between
  // two sweeps. Without the sweep it would have been discovered on the bill.
  //
  // The frontend authorizer is the right place to watch, for two reasons.
  // It is on the path of every tenant site/auth request (`authorizerResult
  // TtlInSeconds: 0` — no caching, so one invocation per request, no
  // undercount), and that path is the only UNBOUNDED one: it is public
  // browser traffic. Everything else here is driven by agents or crons,
  // whose rate we set ourselves.
  //
  // The threshold is calibrated on the measured baseline, like the alarms
  // above, but the arithmetic runs the other way — this one must sit far
  // ENOUGH ABOVE normal to never cry wolf, while still catching a loop
  // early. It was first set at 3 000/hour, when the busiest legitimate hour
  // was under 200. Tenant sites grew: a tenant's legitimate traffic came to
  // cross that line repeatedly, each firing analysed as "no incident" — and
  // an alarm that is usually wrong trains its reader to ignore it, which is
  // worse than no alarm. FRONTEND_AUTHORIZER_VOLUME_THRESHOLD is therefore
  // sized above the legitimate peak observed, and still far below a runaway
  // loop: the 2026-08-27 one ran at ~36 000/hour, more than four times the
  // threshold, so a loop of that kind still crosses it within its first
  // quarter of an hour. Re-measure and raise it again when legitimate traffic
  // approaches it; do not let it fire on normal days.
  //
  // An app's OWN backend answering 5xx on its site routes. The platform alarm
  // subtracts this population on purpose (a client's 500 is the client's to
  // fix) — and until 2026-09-03 nobody was told, the org included. This alarm
  // exists to ROUTE it: the relay wakes the connector, whose analyser names
  // the app and the path and hands the customer a fiche with the fix
  // (connector src/incident-analysers.ts, APP_5XX). Three errors in five
  // minutes is already a broken feature for a real visitor; one or two may be
  // a deploy in flight. Silence is not breaching: no errors is the goal.
  alertOn(
    new cloudwatch.Alarm(stack, "TenantApp5xxAlarm", {
      metric: httpApi5xxTenantAppFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Dilaya tenant apps: an app's own backend returned >= 3 × 5xx on its /site routes in 5 " +
        "minutes (integrationStatus 200 = the app's code produced the error, not the platform). " +
        "NOT a platform fault — this alarm exists so the connector's incident analyser names the " +
        "org/app/path from the HttpApiAccessLogs group and tells THAT org (MCP notice + agent inbox + " +
        "owner email via dilaya.eu). Read the analyser's `incident` log line for the verdict.",
    })
  );

  // The period is an hour on purpose. This is a COST alarm, not an outage
  // one: nothing is broken, nothing is down, and the question it answers —
  // "is someone burning money right now?" — does not get a better answer
  // for being asked every five minutes. An hourly window also refuses to
  // fire on a legitimate short burst, which a 5-minute window at the
  // equivalent rate would do regularly.
  if (frontendAuthorizerRef) {
    alertOn(
      new cloudwatch.Alarm(stack, "FrontendAuthorizerVolumeAlarm", {
        metric: frontendAuthorizerRef.metricInvocations({
          period: cdk.Duration.hours(1),
          statistic: "Sum",
        }),
        threshold: FRONTEND_AUTHORIZER_VOLUME_THRESHOLD,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // Same reasoning as the Errors alarms: no traffic is silence.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          `Dilaya connector: FrontendAuthorizer invocations >= ${FRONTEND_AUTHORIZER_VOLUME_THRESHOLD} in 1 hour ` +
          "(sized above the legitimate peak observed, still far below a runaway loop). " +
          "This is a VOLUME alarm, not a failure one — everything is probably answering 200. It " +
          "means one tenant frontend is calling far more than any page legitimately does, almost " +
          "always a loop in the app's own code (a setInterval without a guard, or an effect that " +
          "re-triggers itself). Find it in the HttpApiAccessLogs group: group the last hour by " +
          "sourceIp and path — a loop is ONE ip on ONE path, which is what separates it from a " +
          "scanner (many paths, 404s) or real popularity (many ips). The org and app are in the " +
          "path (/o/{orgId}/{app}/...); tell that app's owner, since the fix is in their page.",
      })
    );
  }

}