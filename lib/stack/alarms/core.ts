import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

export function createCoreAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, fn, monitoredFunctions } = ctx;

  // --- Core alarms -------------------------------------------------------
  // Deliberately OUTSIDE the customDomain branch: whether the connector is
  // reached by vanity domain or by raw API endpoint has nothing to do with
  // whether its failures are noticed.
  //
  // Until 2026-08-08 this account held FIVE alarms in total — four on the two
  // database VMs and the capability one — so nothing whatsoever watched
  // `AWS/Lambda Errors`, `AWS/ApiGateway 5xx` or DynamoDB. Every instrument in
  // the sweep recipe was read by hand, twice a day: the 10 gateway 5xx of
  // 2026-08-05 and the 17 % CloudFront 5xx on *.dilaya-apps.eu both sat
  // through two consecutive "prod entirely clean" sweeps before anyone saw
  // them. These alarms close the ~12 h window between sweeps.
  //
  // Thresholds are calibrated on the measured baseline, not guessed: Lambda
  // `Errors` and `Throttles` have been flat 0 since 2026-08-03, and gateway
  // `5xx` 0 since 2026-08-05 21:03Z with the landing API as a control at 0
  // over 7 days. Against an empirically zero floor, ">= 1 in 5 minutes" is
  // not noisy — it is the smallest signal that means something happened.
  for (const { label, fn: monitored } of monitoredFunctions) {
    for (const [metricName, metric] of [
      ["Errors", monitored.metricErrors()],
      ["Throttles", monitored.metricThrottles()],
    ] as const) {
      alertOn(
        new cloudwatch.Alarm(stack, `${label}${metricName}Alarm`, {
          metric: metric.with({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          // A function with no traffic reports no datapoint; that is silence,
          // not failure. BREACHING here would page on every quiet night.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: `Dilaya connector: ${label} Lambda ${metricName} >= 1 in 5 min (baseline is 0).`,
        })
      );
    }
  }

}