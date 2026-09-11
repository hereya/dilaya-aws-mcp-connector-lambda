import * as cdk from "aws-cdk-lib/core";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "./context";

export function createCapabilityAlarm(stack: cdk.Stack, ctx: StackContext): void {
  const { fn } = ctx;

  // Capability-rejection alarm. The VM denies a Data API call whose HMAC
  // capability token is missing/invalid; the connector logs the rejection
  // ("capability rejected: <reason>"). A burst of these took ~21h to surface
  // via the log sweep (2026-07-06 bad_signature incident) — this filter+alarm
  // turns any recurrence into a metric datapoint within minutes. `fn.logGroup`
  // pre-creates/adopts /aws/lambda/<fn> so the filter never races the lazy
  // log-group creation on a fresh stack.
  //
  // ⚠️ For its first month this alarm had NO action, on the theory that "the
  // alarm state itself is the signal". It isn't: nothing polls an alarm state.
  // The only reader was the twice-a-day log sweep — precisely the ~21h delay
  // the alarm was created to remove, and the task that shipped it recorded
  // "fires within minutes (SNS→Telegram)" for a chain that did not exist
  // (found by the 2026-08-08 sweep). It now speaks through the same relay
  // pattern that `dilaya/aws-sqlite-data` proved in prod on 2026-08-07.
  const capabilityRejectedFilter = new logs.MetricFilter(stack, "CapabilityRejectedFilter", {
    logGroup: fn.logGroup,
    metricNamespace: "Dilaya/Connector",
    metricName: "CapabilityRejected",
    filterPattern: logs.FilterPattern.literal('"capability rejected"'),
    metricValue: "1",
  });
  const capabilityRejectedAlarm = new cloudwatch.Alarm(stack, "CapabilityRejectedAlarm", {
    metric: capabilityRejectedFilter.metric({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription:
      "Dilaya connector: Data API capability rejections (e.g. bad_signature) in the last 5 min — " +
      "see the 2026-07-06 incident; a poisoned Lambda env can hide behind poll-only traffic.",
  });
  ctx.capabilityRejectedAlarm = capabilityRejectedAlarm;
}