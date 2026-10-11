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
 * alarm (alarms/core.ts) that says the day a cap starts to bite — and, since
 * 0.1.105, a HEADROOM alarm (alarms/headroom.ts) that says it BEFORE: at 70 %
 * of the reservation, while nobody is refused yet.
 *
 * Arithmetic: the account limit is 2 000 (the 400 → 2 000 raise asked on
 * 22/09 was granted; verified live on 11/10/2026 against Service Quotas
 * L-B99A9384 in eu-west-1). 150+200+50+50 = 450 reserved leaves 1 550
 * unreserved for the tenant backends, far above AWS's floor of 100. A deploy
 * against a lower account limit fails loudly in CloudFormation and rolls back
 * — it cannot silently starve the apps.
 *
 * Each figure is a deploy param (`-p reservedConcurrency<Label>=<n>`); `0` or
 * `none` removes the reservation for that function. The account limit itself
 * is `-p lambdaAccountConcurrency=<n>` — a declared figure, since no quota
 * read happens at synth: when a support case grants a new one, it goes there.
 *
 * SCALING LADDER (t_concurrency_headroom). The number of organisations is not
 * the variable — concurrency counts requests in flight at the same instant,
 * so a thousand quiet sites cost nothing. What raises the floor is ONE burst
 * (a scanner, a viral site, a tenant loop). When a headroom alarm fires
 * outside a burst, or keeps firing: raise that function's reservation (auth
 * Lambda 50 → 150, front door 200 → 500 are the first steps), keep the sum
 * ≥ 100 under the account limit, and when the account alarm fires ask AWS
 * for the next tier (5 000). All of it is a parameter deploy, no code.
 */
export const RESERVED_CONCURRENCY_DEFAULTS: Record<string, number> = {
  Handler: 150,
  // Also the front door (t_app_routing_o1): it holds a slot while the app
  // answers, so site traffic counts twice here.
  FrontendAuthorizer: 200,
  McpAuthorizer: 50,
  AuthLambda: 50,
};

/** The regional Lambda concurrency limit this stack is deployed against. */
export const LAMBDA_ACCOUNT_CONCURRENCY_DEFAULT = 2000;

function positiveInt(name: string, raw: string, alsoAllowed = ""): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer${alsoAllowed} (got "${raw}")`);
  }
  return n;
}

export function reservedConcurrencyFor(label: string, env = process.env): number | undefined {
  const fallback = RESERVED_CONCURRENCY_DEFAULTS[label];
  const raw = env[`reservedConcurrency${label}`]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "0" || raw.toLowerCase() === "none") return undefined;
  return positiveInt(`reservedConcurrency${label}`, raw, ", 0 or none");
}

export function lambdaAccountConcurrency(env = process.env): number {
  const raw = env["lambdaAccountConcurrency"]?.trim();
  if (raw === undefined || raw === "") return LAMBDA_ACCOUNT_CONCURRENCY_DEFAULT;
  return positiveInt("lambdaAccountConcurrency", raw);
}

export function applyReservedConcurrency(_stack: cdk.Stack, ctx: StackContext): void {
  for (const { label, fn } of ctx.monitoredFunctions) {
    const n = reservedConcurrencyFor(label);
    if (n === undefined) continue;
    (fn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = n;
  }
}
