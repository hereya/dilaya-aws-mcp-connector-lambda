import * as cdk from "aws-cdk-lib/core";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import type { StackContext } from "./context";

/**
 * The sweep tick — the connector's housekeeping, OFF the request path
 * (t_floor_syncs_offpath, 2026-10-10).
 *
 * The connector runs six one-shot sweeps (runtime-layer propagation, the edge
 * host map, edge usage, cron suspension, stalled custom domains, the one-time
 * auth-route heal). Until 0.1.358 every one of them was `await`ed at the top
 * of EVERY invocation, before any route was dispatched: each claims a
 * DynamoDB window, and the single request that WON the claim ran the work
 * inline, before its own answer. Measured 2026-10-10 on the handler log: a
 * cold container, the host-map floor check and an edge-usage read landed on
 * the same request and it answered in 8 072 ms — a customer's MCP call or
 * dilaya.eu's billing tick, whichever the clock picked. 131 edge-usage runs a
 * day meant the floor fell on a first request four to eight times an hour.
 *
 * This rule is the replacement: EventBridge invokes the connector every five
 * minutes with the marked envelope below, and that invocation — nobody's
 * request — is the only one that runs the sweeps. The DynamoDB claims stay
 * exactly what they were (the tick may land while a previous tick still holds
 * a window; losing the claim is the normal case), and every per-run cap and
 * time floor inside the sweeps still applies, now against a budget nobody
 * else is waiting on.
 *
 * THE ENVELOPE CARRIES NOTHING — the same shape as the alarm envelope
 * (lib/stack/alarm-relay.ts): no org, no app, no sweep name. The connector
 * branches on the marker and runs its whole fixed list; there is no input a
 * caller could use to steer it at a tenant. The grant this target adds is the
 * resource policy letting events.amazonaws.com invoke the connector — a
 * resource, not a role statement, so the connector role's policy document
 * (whose statement ORDER is load-bearing, see the stack constructor) is not
 * touched.
 *
 * Unconditional on purpose: a sweep whose feature is not configured returns
 * at once inside the connector (no APP_STATE_TABLE, no edge logs, no cron
 * group), so the tick costs one short invocation per five minutes — ~8 640 a
 * month, inside the Lambda free tier — on every deployment shape.
 */
export const SWEEP_TICK_RATE = cdk.Duration.minutes(5);

/** The marker the connector branches on (src/handler/sweep-envelope.ts). */
export const SWEEP_ENVELOPE = { __dilaya: "sweep" } as const;

export function createSweepTick(stack: cdk.Stack, ctx: StackContext): void {
  new events.Rule(stack, "SweepTick", {
    description:
      "Dilaya connector housekeeping sweeps, every 5 minutes, off the request path",
    schedule: events.Schedule.rate(SWEEP_TICK_RATE),
    targets: [
      new targets.LambdaFunction(ctx.fn, {
        event: events.RuleTargetInput.fromObject(SWEEP_ENVELOPE),
        // A tick that could not be delivered is worthless once the next one
        // is due: drop it rather than queue a burst of stale sweeps.
        maxEventAge: cdk.Duration.minutes(4),
        retryAttempts: 1,
      }),
    ],
  });
}
