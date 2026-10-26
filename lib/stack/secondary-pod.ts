import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

/**
 * What a SECONDARY pod's connector needs of the primary region (Région Canada,
 * t_rca_p1_router — blockers B1 + G3). Inert unless `skipGlobalResources=true`,
 * so the primary pod's template is byte-identical (scripts/synth-golden.ts).
 *
 * B1 — the registry's GLOBAL partitions (`_hosts`: vanity hosts, org slugs,
 * bought domains, BYOD distributions; `_catalog`) live ONLY in the primary
 * (EU) registry, the sole source of truth. The connector (≥ 0.1.405) reaches
 * them cross-region through `GLOBAL_REGISTRY_TABLE_ARN`; its org/app rows stay
 * in the pod's own registry. The grant is pinned by `dynamodb:LeadingKeys` to
 * those two partitions: this pod can never read or write an EU org's rows.
 * `POD_ROLE=secondary` turns off the connector's sweeps that mutate
 * once-per-account resources (edge host map, edge usage, domain watch).
 *
 * G3 — a static env value given as an `aws:` SSM ARN of ANOTHER region (the
 * GitHub App key, eu-west-1) is not resolved by the executor deploying here: it
 * arrives as the ARN itself, and the connector resolves it at runtime in that
 * region. Grant ssm:GetParameter on exactly those ARNs (+ KMS via SSM there).
 */
export function wireSecondaryPod(stack: cdk.Stack, ctx: StackContext): void {
  if (!ctx.skipGlobalResources) return;
  const { fn } = ctx;
  fn.addEnvironment("POD_ROLE", "secondary");

  const tableArn = process.env["globalRegistryTableArn"] || undefined;
  if (tableArn) {
    if (!TABLE_ARN_RE.test(tableArn)) {
      throw new Error(`globalRegistryTableArn must be a DynamoDB table ARN; got ${tableArn}`);
    }
    fn.addEnvironment("GLOBAL_REGISTRY_TABLE_ARN", tableArn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [...GLOBAL_PARTITIONS] },
        },
      })
    );
  }

  const ssmArns = crossRegionSsmArns(ctx.nonPolicyEnv, stack.region);
  if (ssmArns.length > 0) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: ssmArns.map((a) => a.arn) })
    );
    const regions = [...new Set(ssmArns.map((a) => a.region))].sort();
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": regions.map((r) => `ssm.${r}.amazonaws.com`) } },
      })
    );
  }
}

/** The two registry partitions that exist once for the whole platform. */
export const GLOBAL_PARTITIONS = ["_hosts", "_catalog"] as const;

const TABLE_ARN_RE = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]{3,255}$/;
const SSM_ARN_RE = /^(?:secret:\/\/)?(?:aws:)?(arn:aws[a-z-]*:ssm:([a-z0-9-]+):\d{12}:parameter\/[\w./-]+)$/;

/**
 * Project-env values that are still an SSM parameter ARN of ANOTHER region —
 * what the executor leaves when it cannot resolve an `aws:` static env value.
 * Same-region ARNs are not this case (the executor resolves those) and get no grant.
 */
export function crossRegionSsmArns(
  env: Record<string, string>,
  podRegion: string
): Array<{ arn: string; region: string }> {
  const out = new Map<string, string>();
  for (const v of Object.values(env)) {
    const m = SSM_ARN_RE.exec(String(v));
    if (m && m[2] !== podRegion) out.set(m[1]!, m[2]!);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([arn, region]) => ({ arn, region }));
}
