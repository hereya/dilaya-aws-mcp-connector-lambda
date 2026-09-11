import * as cdk from "aws-cdk-lib/core";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

export function createRateGuardAlarm(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, frontendAuthorizerRef } = ctx;
  // --- What the rate guard WOULD have refused ---------------------------
  // The guard ships in COUNT mode (see the authorizer's checkRate): it logs
  // one `rate_guard` line per offending request and refuses nothing. That
  // makes this filter the ONLY way to know it is doing anything at all — a
  // component that RUNS without DELIVERING is invisible to every instrument
  // that counts executions, which is exactly how the alarm relay sat broken
  // for two real firings (t_e95d603a0a32).
  //
  // The same line, and therefore this same alarm, keeps working when blocking
  // is switched on: `blocked` inside the line says which happened, so nothing
  // here has to change on the day the mode flips.
  //
  // Substring-free JSON pattern, and deliberately NO dimensions: CloudWatch
  // refuses a metric filter carrying both `dimensions` and a `defaultValue`,
  // and refuses dimensions altogether on a pattern that does not extract
  // named fields — two rules a green `cdk synth` does not enforce and that
  // cost a rolled-back production deploy on 2026-08-27.
  if (frontendAuthorizerRef) {
    const rateGuardFilter = new logs.MetricFilter(stack, "RateGuardFilter", {
      logGroup: frontendAuthorizerRef.logGroup,
      metricNamespace: "Dilaya/Connector",
      metricName: "RateGuardTripped",
      filterPattern: logs.FilterPattern.literal('{ $.type = "rate_guard" }'),
      metricValue: "1",
    });
    alertOn(
      new cloudwatch.Alarm(stack, "RateGuardAlarm", {
        metric: rateGuardFilter.metric({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Dilaya connector: a tenant frontend crossed the per-IP rate guard (default 1000 requests " +
          "per minute per IP) in the last 5 min. While FRONTEND_RATE_BLOCK is false this refused " +
          "NOTHING — it reports what a block WOULD have cut, which is the data needed before " +
          "turning blocking on. Read the `rate_guard` lines in the FrontendAuthorizer log group: " +
          "`blocked` says whether it was enforced, `hits` how far over, `app`/`org` who, and `ip` " +
          "is a truncated hash (the same tag across a minute = the same address). One hashed ip " +
          "far over the limit on one path is a runaway loop in that app's page; several distinct " +
          "tags near the limit is more likely a shared address (corporate NAT, mobile carrier) — " +
          "which is the case that must NOT be blocked.",
      })
    );
  }

}