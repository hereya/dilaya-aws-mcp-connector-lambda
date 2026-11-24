import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { StackContext } from "../context";
import { BRIDGE_STEP_MS, BridgedMetric, metricsBridgeSource } from "../region-router/metrics-bridge";

/** Where the edge's metrics are copied to, in this stack's region. */
export const EDGE_NAMESPACE = "Dilaya/Edge";

/**
 * The CloudFront alarms of the distributions this stack owns, and of the apphost router function.
 *
 * Until now no alarm watched them: CloudFront publishes in us-east-1 ONLY, an alarm watches a metric
 * of its own region, and this package's deploy creates ONE stack, in the pod's region (a us-east-1
 * stack has no deploy path — region-router/edge-stack.ts). So, exactly like the region router
 * (region-router/alarms.ts), a small function copies the metrics here every five minutes and plain
 * alarms speak through the existing relay (alertOn → Telegram + the ops agent). A breach shows 5 to
 * 15 minutes late. Cost: one invocation and one GetMetricData every five minutes.
 *
 * The router function's metrics carry no DistributionId, so they cover every distribution that runs
 * the function — the platform's and the BYOD ones the connector creates. The 5xx alarm covers only
 * the distributions declared in this stack (the BYOD ones are made at run time, not here).
 *
 * 5xx rule — `5xxErrorRate >= 5 % AND Requests >= 20` in one 5-minute bucket. The rate alone pages on
 * one failure out of one request at night; the floor of 20 makes that impossible. Replayed on 45
 * days of the vanity-host distribution (~120 000 requests, 24 buckets with any 5xx): 3 firings, each
 * a run of 502s from one app's origin. Tenant 5xx are counted: a site answering 5xx is the signal.
 * Function errors: >= 1, baseline 0 — 4 validation errors in 45 days, each a 502 for a visitor.
 */
export function createEdgeAlarms(stack: cdk.Stack, ctx: StackContext): void {
  const dists: Array<[string, cloudfront.Distribution | undefined]> = [
    ["AppContent", ctx.appContentDistribution],
    ["Files", ctx.filesDistribution],
    ["Frontend", ctx.distribution],
  ];
  const owned = dists.filter((d): d is [string, cloudfront.Distribution] => d[1] !== undefined);
  const routerFn = ctx.appHostRouterFn;
  if (owned.length === 0 && !routerFn) return;

  const env: Record<string, string> = {};
  const metrics: BridgedMetric[] = [];
  for (const [label, dist] of owned) {
    const key = `${label.toUpperCase()}_DISTRIBUTION_ID`;
    env[key] = dist.distributionId;
    const dims = { DistributionId: `env:${key}`, Region: "Global" };
    metrics.push(
      { name: `${label}5xxErrorRate`, metricName: "5xxErrorRate", dimensions: dims, stat: "Average", unit: "Percent" },
      { name: `${label}Requests`, metricName: "Requests", dimensions: dims, stat: "Sum", unit: "Count" }
    );
  }
  const fnMetrics = ["FunctionExecutionErrors", "FunctionValidationErrors"];
  if (routerFn) {
    env.ROUTER_FUNCTION_NAME = routerFn.functionName;
    const dims = { FunctionName: "env:ROUTER_FUNCTION_NAME", Region: "Global" };
    for (const m of fnMetrics) {
      metrics.push({ name: `AppHostRouter${m}`, metricName: m, dimensions: dims, stat: "Sum", unit: "Count" });
    }
  }

  const bridge = new lambda.Function(stack, "EdgeMetricsBridge", {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: lambda.Code.fromInline(metricsBridgeSource(metrics, EDGE_NAMESPACE)),
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: env,
    description: "Copies the edge's us-east-1 CloudFront metrics into this region for its alarms",
  });
  bridge.addToRolePolicy(new iam.PolicyStatement({ actions: ["cloudwatch:GetMetricData"], resources: ["*"] }));
  bridge.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": EDGE_NAMESPACE } },
    })
  );
  new events.Rule(stack, "EdgeMetricsTick", {
    description: "Edge metrics bridge (us-east-1 CloudFront → this region), every 5 minutes",
    schedule: events.Schedule.rate(cdk.Duration.minutes(BRIDGE_STEP_MS / 60000)),
    // No retry: a retried run would publish the same bucket twice.
    targets: [new targets.LambdaFunction(bridge, { retryAttempts: 0, maxEventAge: cdk.Duration.minutes(4) })],
  });

  const period = cdk.Duration.minutes(5);
  const bridged = (metricName: string, statistic: string) =>
    new cloudwatch.Metric({ namespace: EDGE_NAMESPACE, metricName, statistic, period });
  const base = {
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  };
  for (const [label] of owned) {
    ctx.alertOn(
      new cloudwatch.Alarm(stack, `${label}Edge5xxAlarm`, {
        ...base,
        // Maximum, not Sum: each bridged point is already a 5-minute aggregate, and a jittered tick
        // can land two in one alarm bucket — Sum would double Requests.
        metric: new cloudwatch.MathExpression({
          expression: "IF(rate >= 5 AND req >= 20, 1, 0)",
          usingMetrics: { rate: bridged(`${label}5xxErrorRate`, "Maximum"), req: bridged(`${label}Requests`, "Maximum") },
          period,
          label: `${label} distribution 5xx >= 5 % of >= 20 requests`,
        }),
        alarmDescription:
          `Dilaya edge: the ${label} CloudFront distribution answered 5xx to >= 5 % of >= 20 requests in a ` +
          "5-minute bucket (read 5-10 min late). Read its edge log: x-edge-result-type (Error = the origin, " +
          "FunctionValidationError / FunctionExecutionError = the viewer function) and the host.",
      })
    );
  }
  if (routerFn) {
    for (const m of fnMetrics) {
      ctx.alertOn(
        new cloudwatch.Alarm(stack, `AppHostRouter${m}Alarm`, {
          ...base,
          metric: bridged(`AppHostRouter${m}`, "Sum"),
          alarmDescription:
            `Dilaya edge: the apphost router CloudFront function reported ${m} >= 1 in a 5-minute bucket ` +
            "(read 5-10 min late), on any distribution running it. Each one is a 502/503 answered to a " +
            "visitor before any origin. Find it in the edge log (x-edge-detailed-result-type) and replay " +
            "the request with `aws cloudfront test-function` on the LIVE stage.",
        })
      );
    }
  }
  // A bridge that throws leaves every alarm above silent for ever (missing = not breaching).
  ctx.alertOn(
    new cloudwatch.Alarm(stack, "EdgeMetricsBridgeErrorsAlarm", {
      ...base,
      metric: bridge.metricErrors({ period, statistic: "Sum" }),
      alarmDescription: "Dilaya edge: the metrics bridge failed — while it does, the edge alarms see nothing.",
    })
  );
}
