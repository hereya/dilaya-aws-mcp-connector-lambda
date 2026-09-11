import * as cdk from "aws-cdk-lib/core";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

export function createRequestCapAlarm(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, frontendAuthorizerRef } = ctx;
  // --- A customer was CUT --------------------------------------------
  // The heaviest action this platform takes: an organization past its
  // monthly request allowance stops being served until the 1st of the next
  // month. It is deliberate (Jonatan, 2026-08-28: unbounded exposure is
  // worse than a bounded outage, and it is his exposure) — but it must never
  // be something we learn about from the customer.
  //
  // The line it counts is written only when a request is actually refused,
  // so this alarm firing means a real site is dark right now.
  if (frontendAuthorizerRef) {
    const requestCapFilter = new logs.MetricFilter(stack, "RequestCapFilter", {
      logGroup: frontendAuthorizerRef.logGroup,
      metricNamespace: "Dilaya/Connector",
      metricName: "RequestCapCut",
      filterPattern: logs.FilterPattern.literal('{ $.type = "request_cap" }'),
      metricValue: "1",
    });
    alertOn(
      new cloudwatch.Alarm(stack, "RequestCapAlarm", {
        metric: requestCapFilter.metric({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Dilaya: an organization has been CUT for exceeding its monthly request allowance — " +
          "its site is returning 403 and will keep doing so until the 1st of next month. This is " +
          "not a fault, it is the cap doing its job, but it needs a human the same day: read the " +
          "`request_cap` lines in the FrontendAuthorizer log group for the org, the count and the " +
          "cap. Either the customer should move up a plan, or their allowance should be raised " +
          "from the admin page — which takes effect within a minute (the authorizer caches the " +
          "cap for 60s). If this fires without a warning having gone out first, the projection " +
          "half of the feature is what failed, not this one.",
      })
    );
  }

}