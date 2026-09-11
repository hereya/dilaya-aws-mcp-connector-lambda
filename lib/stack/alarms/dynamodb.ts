import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

export function createAppStateAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, appStateTable } = ctx;
  // DynamoDB, blind in yet another direction: a throttled or failed state
  // write is not a Lambda error and never reaches the gateway either.
  for (const metricName of ["SystemErrors", "ThrottledRequests"] as const) {
    alertOn(
      new cloudwatch.Alarm(stack, `AppState${metricName}Alarm`, {
        metric: new cloudwatch.Metric({
          namespace: "AWS/DynamoDB",
          metricName,
          dimensionsMap: { TableName: appStateTable.tableName },
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Dilaya connector: AppStateTable ${metricName} >= 1 in 5 min (baseline is 0).`,
      })
    );
  }
}