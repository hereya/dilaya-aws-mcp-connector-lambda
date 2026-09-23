import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { StackContext } from "./context";

/**
 * Reserved concurrency for the platform's own functions (t_reserved_concurrency).
 *
 * Every Lambda in the account — the connector, its authorizers, and every
 * tenant app backend — draws from ONE regional concurrency pool. A tenant loop
 * (or a burst of cron firings) could drain it and throttle `/mcp` for every
 * org at once. Reserving a slice guarantees the platform's own doors keep
 * answering; the reservation is ALSO a cap, so each figure sits well above the
 * 14-day peak measured on 22/09 (connector 93, frontend authorizer 64, MCP
 * authorizer 27, auth Lambda 29), and each function already has a Throttles
 * alarm (alarms/core.ts) that says the day a cap starts to bite.
 *
 * Arithmetic: the account limit is 1 000 (2 000 requested). 150+100+50+50 =
 * 350 reserved leaves 650 unreserved (450 → 550 once the frontend authorizer
 * became the front door and went to 200), far above AWS's floor of 100. A deploy
 * against a lower account limit fails loudly in CloudFormation and rolls back
 * — it cannot silently starve the apps.
 *
 * Each figure is a deploy param (`-p reservedConcurrency<Label>=<n>`); `0` or
 * `none` removes the reservation for that function.
 */
export const RESERVED_CONCURRENCY_DEFAULTS: Record<string, number> = {
  Handler: 150,
  // Also the front door (t_app_routing_o1): it holds a slot while the app
  // answers, so site traffic counts twice here.
  FrontendAuthorizer: 200,
  McpAuthorizer: 50,
  AuthLambda: 50,
};

export function reservedConcurrencyFor(label: string, env = process.env): number | undefined {
  const fallback = RESERVED_CONCURRENCY_DEFAULTS[label];
  const raw = env[`reservedConcurrency${label}`]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "0" || raw.toLowerCase() === "none") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`reservedConcurrency${label} must be a positive integer, 0 or none (got "${raw}")`);
  }
  return n;
}

export function applyReservedConcurrency(_stack: cdk.Stack, ctx: StackContext): void {
  for (const { label, fn } of ctx.monitoredFunctions) {
    const n = reservedConcurrencyFor(label);
    if (n === undefined) continue;
    (fn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = n;
  }
}
