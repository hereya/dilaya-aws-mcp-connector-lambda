import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * The integrated dev agent's model calls on AWS Bedrock, EU cross-region inference
 * profiles (`eu.anthropic.claude-haiku-5-5`, `eu.anthropic.claude-sonnet-5-5`),
 * for the organizations listed in `devAgentBedrockOrgs` — every other one keeps
 * the Claude API (the connector decides per org, `src/dev-agent/provider.ts`).
 *
 *   devAgentBedrockOrgs absent or "" → NOTHING changes: no env var, no statement.
 *   a comma-separated list of org ids (UUIDs) → the worker gets it as
 *     DEV_AGENT_BEDROCK_ORGS and ONE role statement pair: bedrock:InvokeModel on
 *     the two EU inference profiles of the stack's account+region, and on the
 *     underlying foundation models in the EU regions those profiles route to —
 *     ONLY when the call comes through one of those profiles (a cross-region
 *     profile needs both grants; the condition keeps the models from being called
 *     directly).
 *   anything else, or a non-EU stack region → the synth FAILS (no silent "off").
 *
 * Only meaningful with the worker on (devAgentWorker=true); without it, ignored.
 */
export const BEDROCK_PARAM = "devAgentBedrockOrgs";
export const BEDROCK_ENV = "DEV_AGENT_BEDROCK_ORGS";
export const BEDROCK_MODELS = ["anthropic.claude-haiku-5-5", "anthropic.claude-sonnet-5-5"] as const;
/** The regions the `eu.` profiles route to (Bedrock `list-inference-profiles`, eu-west-1, 2026-11). */
export const EU_PROFILE_REGIONS = ["eu-west-1", "eu-west-3", "eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The org ids, or [] when off. Throws on a malformed list (a typo must not deploy as "off"). */
export function bedrockOrgs(): string[] {
  const raw = process.env[BEDROCK_PARAM];
  if (raw === undefined || raw.trim() === "") return [];
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.find((id) => !UUID.test(id));
  if (bad !== undefined || ids.length === 0) throw new Error(`${BEDROCK_PARAM}: expected comma-separated org ids (UUIDs)`);
  return ids;
}

/** The env entry for the worker ({} when off). */
export function bedrockEnv(): Record<string, string> {
  const ids = bedrockOrgs();
  return ids.length ? { [BEDROCK_ENV]: ids.join(",") } : {};
}

export function grantWorkerBedrock(stack: cdk.Stack, worker: lambda.Function): void {
  if (bedrockOrgs().length === 0) return;
  if (cdk.Token.isUnresolved(stack.region) || !/^eu-/.test(stack.region)) {
    throw new Error(`${BEDROCK_PARAM} needs an EU stack region (the eu. inference profiles)`);
  }
  const profiles = BEDROCK_MODELS.map((m) => `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.${m}`);
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: profiles }));
  worker.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: EU_PROFILE_REGIONS.flatMap((r) => BEDROCK_MODELS.map((m) => `arn:aws:bedrock:${r}::foundation-model/${m}`)),
      conditions: { StringLike: { "bedrock:InferenceProfileArn": profiles } },
    })
  );
}
