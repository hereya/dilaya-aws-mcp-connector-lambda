import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "../context";
import { grantByodDistributions } from "./byod-iam";

/**
 * The BYOD control plane on a CONSUMER pod (Région Canada, t_rca_byod_ca).
 *
 * A BYOD distribution is an ACCOUNT resource, not a pod's: whichever pod
 * creates it, it is the same shape — the primary's API origin host, the
 * primary's router function, origin-request and cache policies, static bucket
 * (+ its OAC) and edge-log bucket. The region of a request is chosen by the
 * router function from the host's KVS value (`g`, router-region.ts), exactly
 * as for a CA org's vanity host, so a distribution never needs to know which
 * pod made it — and the primary's daily repair (dilaya-connector
 * edge-usage-sync → ensureDistributionEdgeLogging / applyOriginHostConfig)
 * finds nothing to undo on one made here.
 *
 * So the consumer pod only needs those seven ids of the primary's edge, as ONE
 * parameter (":"-separated, because hereya cuts a -p at every "="):
 *
 *   appContentByodEdge  <routerFunctionName>:<originRequestPolicyId>:<cachePolicyId>:
 *                       <staticOacId>:<staticBucketRegionalDomain>:<edgeLogBucketRegionalDomain>:
 *                       <primaryOriginHost>
 *
 * The connector reads them under the names it already reads on the primary
 * (the two bucket domains and the origin host as their explicit overrides —
 * dilaya-connector src/byod-domains/derived-env.ts, origin-host.ts), plus the
 * origin-lock secret, and gets the primary's BYOD grants (byod-iam.ts: ABAC on
 * the `dilaya:byod=1` tag — the same reach, on the same once-per-account
 * resources, as the primary's role).
 * Absent → never called: the consumer template is unchanged.
 */
export interface ByodEdge {
  functionName: string;
  originRequestPolicyId: string;
  cachePolicyId: string;
  staticOacId: string;
  staticBucketDomain: string;
  edgeLogBucketDomain: string;
  originHost: string;
}

const FN_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OAC_RE = /^[A-Z0-9]{8,32}$/;
const BUCKET_DOMAIN_RE = /^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3\.[a-z]{2}(-[a-z]+)+-\d\.amazonaws\.com$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const FORMAT =
  "<routerFunctionName>:<originRequestPolicyId>:<cachePolicyId>:<staticOacId>:<staticBucketDomain>:<edgeLogBucketDomain>:<originHost>";

/** Parse + validate the parameter; undefined when absent. Throws on any malformed field. */
export function parseByodEdge(raw: string | undefined): ByodEdge | undefined {
  if (!raw) return undefined;
  const f = raw.trim().split(":");
  const bad = (what: string) => new Error(`appContentByodEdge: ${what} — expected ${FORMAT}`);
  if (f.length !== 7) throw bad(`${f.length} fields`);
  const [functionName, originRequestPolicyId, cachePolicyId, staticOacId, staticBucketDomain, edgeLogBucketDomain, originHost] = f as [
    string, string, string, string, string, string, string,
  ];
  if (!FN_NAME_RE.test(functionName)) throw bad("router function name");
  if (!UUID_RE.test(originRequestPolicyId)) throw bad("origin-request policy id");
  if (!UUID_RE.test(cachePolicyId)) throw bad("cache policy id");
  if (!OAC_RE.test(staticOacId)) throw bad("static OAC id");
  if (!BUCKET_DOMAIN_RE.test(staticBucketDomain)) throw bad("static bucket regional domain");
  if (!BUCKET_DOMAIN_RE.test(edgeLogBucketDomain)) throw bad("edge-log bucket regional domain");
  if (!HOST_RE.test(originHost)) throw bad("origin host");
  return { functionName, originRequestPolicyId, cachePolicyId, staticOacId, staticBucketDomain, edgeLogBucketDomain, originHost };
}

/** Wire the consumer pod's connector to the primary's BYOD edge (consumer.ts calls it). */
export function consumeByodControlPlane(stack: cdk.Stack, ctx: StackContext): void {
  const edge = ctx.appContentByodEdge!;
  const { fn } = ctx;
  fn.addEnvironment("APP_CONTENT_CF_FUNCTION_NAME", edge.functionName);
  fn.addEnvironment("APP_CONTENT_ORIGIN_REQUEST_POLICY_ID", edge.originRequestPolicyId);
  fn.addEnvironment("APP_CONTENT_CACHE_POLICY_ID", edge.cachePolicyId);
  fn.addEnvironment("APP_STATIC_OAC_ID", edge.staticOacId);
  // Explicit overrides: derived from this pod's own bucket / region they would
  // name the CA bucket and a bucket that does not exist.
  fn.addEnvironment("APP_STATIC_BUCKET_DOMAIN", edge.staticBucketDomain);
  fn.addEnvironment("EDGE_LOG_BUCKET_DOMAIN", edge.edgeLogBucketDomain);
  // The host every BYOD distribution fronts — the PRIMARY's origin host.
  fn.addEnvironment("POD_ORIGIN_HOST", edge.originHost);
  // A distribution created without it would be refused by every authorizer.
  fn.addEnvironment("APP_CONTENT_ORIGIN_SECRET", ctx.appContentOriginSecret!);

  grantByodDistributions(stack, ctx);
  // CloudFront checks the caller can read the log bucket's ACL when a
  // distribution's access log points at it (the primary's role holds it
  // through its grantRead on that bucket). Same account: no bucket policy.
  const logBucket = BUCKET_DOMAIN_RE.exec(edge.edgeLogBucketDomain)![1];
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetBucketAcl"],
      resources: [`arn:aws:s3:::${logBucket}`],
    })
  );
}
