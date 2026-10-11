import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";
import { lambdaAccountConcurrency, reservedConcurrencyFor } from "../reserved-concurrency";

/** The fraction of a ceiling at which headroom is declared gone. */
export const HEADROOM_FRACTION = 0.7;

export function headroomThreshold(ceiling: number): number {
  return Math.ceil(ceiling * HEADROOM_FRACTION);
}

/**
 * Concurrency HEADROOM alarms (t_concurrency_headroom, 0.1.105).
 *
 * A reservation is also a cap, and until now the only instrument on it was
 * `Throttles >= 1` — which rings once real visitors are ALREADY refused. On
 * 2026-10-06 the auth Lambda sat at 50/50 (117 throttles, every tenant's
 * login page down for the burst) with no signal before it; on 10/10 a single
 * scanner held 29 of the 50 and nothing said so. These alarms watch the
 * same `ConcurrentExecutions` metric the reservation caps, at 70 % of each
 * ceiling, and say "the margin is going" while there still is one.
 *
 * Calibration, 14 days to 11/10/2026 (max per day): auth Lambda <= 40 (50
 * on 06/10), front door <= 56 (180 on 06/10), connector and MCP authorizer
 * far below. Only the 06/10 incident day would have fired — which is the
 * point: one true day in fourteen, zero false ones. `Maximum` over 5 min, 2
 * datapoints out of 3, so a single 5-minute spike (a login burst the edge
 * cache now absorbs in a minute) stays quiet and a sustained one does not.
 *
 * The thresholds DERIVE from the reservation (`reservedConcurrencyFor`) and
 * from the declared account limit (`lambdaAccountConcurrency`): raising a
 * reservation moves its alarm with it, and there is no second figure to
 * forget. A function whose reservation was removed (`none`) has no ceiling
 * of its own and gets no alarm — the account one still covers it.
 *
 * The account alarm carries NO dimension: `AWS/Lambda ConcurrentExecutions`
 * without `FunctionName` is the account-wide figure, the one a tenant loop or
 * a burst of cron firings drains — the 1 550 unreserved slots the apps share.
 * It is the only alarm here that sees the tenants at all.
 */
export function createHeadroomAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, monitoredFunctions } = ctx;

  for (const { label, fn } of monitoredFunctions) {
    const reserved = reservedConcurrencyFor(label);
    if (reserved === undefined) continue;
    const threshold = headroomThreshold(reserved);
    alertOn(
      new cloudwatch.Alarm(stack, `${label}HeadroomAlarm`, {
        metric: fn.metric("ConcurrentExecutions", {
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          `Dilaya connector: ${label} Lambda ran >= ${threshold} concurrent executions ` +
          `(70 % of its ${reserved} reserved) in 2 of the last 3 five-minute windows. Nobody is ` +
          `refused yet — this is the margin going. A burst from one address is a scanner (see the ` +
          `rate_guard lines); a steady climb is growth: raise reservedConcurrency${label} and keep ` +
          `the sum under the account limit (lib/stack/reserved-concurrency.ts, the scaling ladder).`,
      })
    );
  }

  const account = lambdaAccountConcurrency();
  const accountThreshold = headroomThreshold(account);
  alertOn(
    new cloudwatch.Alarm(stack, "AccountConcurrencyHeadroomAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "ConcurrentExecutions",
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: accountThreshold,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        `Dilaya platform: the whole AWS account ran >= ${accountThreshold} concurrent Lambda ` +
        `executions (70 % of the declared ${account} regional limit) in 2 of the last 3 ` +
        `five-minute windows — the pool every tenant app backend shares with the platform's ` +
        `reservations. Find the function by ConcurrentExecutions per FunctionName; a tenant loop ` +
        `is throttled by its org's gateway rate, a cron storm by CRON_LIMIT. If it is growth, ask ` +
        `AWS for the next tier and set lambdaAccountConcurrency to the granted figure.`,
    })
  );
}
