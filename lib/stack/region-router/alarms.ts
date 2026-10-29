import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { StackContext } from "../context";
import { BRIDGE_NAMESPACE, BRIDGE_STEP_MS, BridgedMetric, metricsBridgeSource } from "./metrics-bridge";

/**
 * The region router's alarms (t_rca_router_alarm, 29/10/2026).
 *
 * After the cutover of 27/10 every call to app.dilaya.eu and mcp.<zone> crosses the router, and
 * NOTHING watched it: the 27/10 incident (the viewer function over its instruction cap → 503
 * FunctionExecutionError on part of /mcp, before any pod) never reached a pod, so every pod alarm
 * stayed silent through it. The connector's alarms cannot see the router at all.
 *
 * Why a bridge: CloudFront publishes its metrics in us-east-1 ONLY, a CloudWatch alarm can only
 * watch a metric of its own region and act on a topic of its own region, and this stack (the only
 * one the package's deploy creates) lives in the pod's region. A us-east-1 stack has no deploy path
 * (edge-stack.ts). So a small function copies the router's metrics here every five minutes, and
 * ordinary alarms speak through the existing relay (alertOn → Telegram + the ops agent).
 * Cost: one invocation and one GetMetricData every five minutes.
 *
 * The price is lateness: a breach shows up 10 to 15 minutes after it starts (the bridge reads a
 * closed bucket, to leave CloudFront's own publishing delay behind it).
 *
 * Thresholds, measured 28-29/10 from the cutover: function errors and throttles 0, 5xx rate 0 %,
 * ~500 requests an hour. FunctionComputeUtilization is copied but NOT alarmed: its hourly maximum
 * sat at 94 % all along while `test-function` on the live code gives 10-21 % for a 1-16 org bearer —
 * unexplained, so a threshold on it would either never fire or cry wolf. Past 100 % a request
 * fails, and the errors alarm catches that.
 */
export function createRegionRouterAlarms(
  stack: cdk.Stack,
  ctx: StackContext,
  ids: { distributionId: string; functionName: string }
): void {
  const fnDims = { FunctionName: "env:ROUTER_FUNCTION_NAME", Region: "Global" };
  const metrics: BridgedMetric[] = [
    { name: "FunctionExecutionErrors", metricName: "FunctionExecutionErrors", dimensions: fnDims, stat: "Sum", unit: "Count" },
    { name: "FunctionThrottles", metricName: "FunctionThrottles", dimensions: fnDims, stat: "Sum", unit: "Count" },
    { name: "FunctionComputeUtilization", metricName: "FunctionComputeUtilization", dimensions: fnDims, stat: "Maximum", unit: "None" },
    {
      name: "5xxErrorRate",
      metricName: "5xxErrorRate",
      dimensions: { DistributionId: "env:ROUTER_DISTRIBUTION_ID", Region: "Global" },
      stat: "Average",
      unit: "Percent",
    },
  ];

  const bridge = new lambda.Function(stack, "RegionRouterMetricsBridge", {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: lambda.Code.fromInline(metricsBridgeSource(metrics)),
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: { ROUTER_FUNCTION_NAME: ids.functionName, ROUTER_DISTRIBUTION_ID: ids.distributionId },
    description: "Copies the region router's us-east-1 CloudFront metrics into this region for its alarms",
  });
  // Neither action takes a resource ARN; the write is held to the bridge's own namespace.
  bridge.addToRolePolicy(new iam.PolicyStatement({ actions: ["cloudwatch:GetMetricData"], resources: ["*"] }));
  bridge.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": BRIDGE_NAMESPACE } },
    })
  );
  new events.Rule(stack, "RegionRouterMetricsTick", {
    description: "Region router metrics bridge (us-east-1 CloudFront → this region), every 5 minutes",
    schedule: events.Schedule.rate(cdk.Duration.minutes(BRIDGE_STEP_MS / 60000)),
    // No retry: a retried run would publish the same bucket twice (and double a Sum).
    targets: [new targets.LambdaFunction(bridge, { retryAttempts: 0, maxEventAge: cdk.Duration.minutes(4) })],
  });

  const alarm = (id: string, metricName: string, statistic: string, threshold: number, description: string) =>
    ctx.alertOn(
      new cloudwatch.Alarm(stack, id, {
        metric: new cloudwatch.Metric({ namespace: BRIDGE_NAMESPACE, metricName, statistic, period: cdk.Duration.minutes(5) }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      })
    );
  alarm(
    "RegionRouterFunctionErrorsAlarm",
    "FunctionExecutionErrors",
    "Sum",
    1,
    "Dilaya region router: its CloudFront viewer function failed (>= 1 in a 5-minute bucket, read 5-10 min late). " +
      "Each failure is a 503 FunctionExecutionError on app.dilaya.eu / mcp before any pod — the 27/10 incident. " +
      "Read the router's edge log (x-edge-result-type) and run `aws cloudfront test-function` on the LIVE stage."
  );
  alarm(
    "RegionRouterFunctionThrottlesAlarm",
    "FunctionThrottles",
    "Sum",
    1,
    "Dilaya region router: its CloudFront viewer function was throttled (>= 1 in a 5-minute bucket, read 5-10 min late)."
  );
  alarm(
    "RegionRouter5xxAlarm",
    "5xxErrorRate",
    "Average",
    5,
    "Dilaya region router: >= 5 % of the requests through the router answered 5xx over a 5-minute bucket " +
      "(read 5-10 min late). The pods' own 5xx alarms cover their faults; this one also sees what dies at the " +
      "edge — a function error, an origin the router cannot reach (a pod host, DNS, TLS)."
  );
  // A bridge that throws leaves the three alarms above silent for ever (missing = not breaching).
  ctx.alertOn(
    new cloudwatch.Alarm(stack, "RegionRouterMetricsBridgeErrorsAlarm", {
      metric: bridge.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Dilaya region router: the metrics bridge failed — while it does, the router's alarms see nothing.",
    })
  );
}
