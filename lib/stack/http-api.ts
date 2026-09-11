import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { StackContext } from "./context";

export function createHttpApi(stack: cdk.Stack, ctx: StackContext): void {

  // -----------------------------------------------------------------------
  // HTTP API
  // -----------------------------------------------------------------------

  const httpApi = new apigwv2.HttpApi(stack, "HttpApi", {
    apiName: stack.stackName,
  });

  // Gateway-level observability. WHY this exists (2026-08-06 sweep finding):
  // a request can fail AT THE GATEWAY — a 502 from a malformed Lambda
  // response, a failed integration, a 504 integration timeout — without ever
  // reaching, or without being blamed on, the Lambda. Such a failure is
  // invisible to every instrument we had:
  //   * `AWS/Lambda Errors` counts only invocations that THREW, so it reads 0;
  //   * the connector's handler logs a per-call `{"type":"authz",…}` trace but
  //     NO per-request status line, so there is nothing to grep either.
  // The `AWS/ApiGateway 5xx` metric did see them — 20 over 7 days, including 9
  // in one hour on 2026-08-05 that two consecutive prod sweeps had read and
  // declared clean (the landing's API measured 0 over the same window, so it
  // was ours, not AWS noise). But with no access log and no per-route metrics
  // we could only count them, never say what they were.
  //
  // So: access logs (the ONLY place `integrationErrorMessage` is written down,
  // i.e. the only way to tell a 502 from a 504) + per-route detailed metrics.
  // Retention is deliberately short — the sweep reads a 7-day metric window,
  // so two weeks keeps a correlatable log line for every hit it can surface,
  // and nothing beyond that is ever read.
  const accessLogGroup = new logs.LogGroup(stack, "HttpApiAccessLogs", {
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // Access-log settings live only on the L1 stage — `HttpApi` exposes no
  // prop for them, and `defaultStage` is created for us by `createDefaultStage`.
  const cfnDefaultStage = httpApi.defaultStage!.node
    .defaultChild as apigwv2.CfnStage;
  cfnDefaultStage.accessLogSettings = {
    destinationArn: accessLogGroup.logGroupArn,
    // One JSON object per request. Ordered by what the sweep actually reads:
    // status first, then WHY (the integration fields — a gateway 5xx with
    // `integrationStatus` absent is a different fault from one with 504), then
    // WHO (ip/ua, to separate a scanner from one of our own components).
    format: JSON.stringify({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      routeKey: "$context.routeKey",
      path: "$context.path",
      status: "$context.status",
      integrationStatus: "$context.integrationStatus",
      integrationErrorMessage: "$context.integrationErrorMessage",
      integrationLatency: "$context.integrationLatency",
      responseLatency: "$context.responseLatency",
      errorMessage: "$context.error.message",
      authorizerError: "$context.authorizer.error",
      sourceIp: "$context.identity.sourceIp",
      userAgent: "$context.identity.userAgent",
    }),
  };
  // --- The last-resort ceiling's numbers, in one place -------------------
  // Repeated verbatim onto every platform route below. API Gateway's merge
  // rule between a route's settings and the stage default is not something
  // to bet a safety ceiling on, so the platform routes state their throttle
  ctx.accessLogGroup = accessLogGroup;
  ctx.cfnDefaultStage = cfnDefaultStage;
  ctx.httpApi = httpApi;
}