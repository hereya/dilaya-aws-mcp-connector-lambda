import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { StackContext } from "../context";

export function createPlatform5xxAlarm(stack: cdk.Stack, ctx: StackContext): void {
  const { alertOn, httpApi5xxAllFilter, httpApi5xxTenantAppFilter } = ctx;
  // The gateway layer, which `AWS/Lambda Errors` structurally cannot see: a
  // 502 malformed response, a refused integration or a 504 integration
  // timeout never makes the Lambda throw. That blind spot is what hid 20 5xx
  // over 7 days until the access log shipped on 2026-08-07.
  //
  // Scoped to OUR 5xx by subtracting the tenant-app population (see the two
  // metric filters on the access log, above). A tenant timing out or refusing
  // its integration still counts as ours — `int != 200` means the gateway
  // could not get a normal answer, and that is a platform question until
  // proven otherwise.
  alertOn(
    new cloudwatch.Alarm(stack, "HttpApiPlatform5xxAlarm", {
      metric: new cloudwatch.MathExpression({
        expression: "total - tenantApp",
        usingMetrics: {
          total: httpApi5xxAllFilter.metric({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          tenantApp: httpApi5xxTenantAppFilter.metric({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
        },
        period: cdk.Duration.minutes(5),
        label: "Gateway 5xx that are ours",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Dilaya connector: platform-origin API Gateway 5xx >= 1 in 5 min (a tenant app answering " +
        "500 on its own /site route is excluded — see HttpApi5xxTenantApp). Read the " +
        "HttpApiAccessLogs group: integrationStatus '-' means the request never reached the " +
        "integration (authorizer or gateway refusal); a populated integrationErrorMessage is what " +
        "separates a 502 from a 504; integrationStatus 200 on a platform route means our own " +
        "handler chose to return that 5xx.",
    })
  );

  // 4xx is deliberately NOT alarmed: it runs 30–85/day of pure scanner noise
  // absorbed by tenant apps (all `int=200`). Alarming it would train everyone
  // to ignore this topic, which is how the alarm layer dies a second time.

}