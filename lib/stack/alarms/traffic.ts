import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

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
  // early. Background is 2–190 invocations/hour; the 2026-08-27 loop ran at
  // ~36 000/hour. 3 000/hour is ~16x the busiest legitimate hour ever
  // measured and ~1/12th of the loop — a real traffic spike (a tenant's
  // launch day, a newsletter) has room to be twelve times the record before
  // it says anything, and a runaway crosses it within the first few minutes.
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
        threshold: 3000,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // Same reasoning as the Errors alarms: no traffic is silence.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Dilaya connector: FrontendAuthorizer invocations >= 3000 in 1 hour (baseline 2-190/h). " +
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