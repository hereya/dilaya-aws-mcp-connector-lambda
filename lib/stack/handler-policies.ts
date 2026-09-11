import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

export function attachDependencyPolicies(stack: cdk.Stack, ctx: StackContext): void {
  const { fn, policyEnv } = ctx;
  // Attach IAM policies from dependency packages
  for (const [, value] of Object.entries(policyEnv)) {
    const policy = JSON.parse(value as string);
    for (const statement of policy.Statement) {
      fn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
    }
  }
}