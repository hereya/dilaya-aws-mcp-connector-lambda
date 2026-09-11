import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "../context";

export function appContentOutputs(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentDistribution, appHostRouterFn } = ctx;
  new cdk.CfnOutput(stack, "AppContentDistributionDomain", {
    value: appContentDistribution.distributionDomainName,
  });
  new cdk.CfnOutput(stack, "AppContentCfFunctionName", {
    value: appHostRouterFn.functionName,
  });
}