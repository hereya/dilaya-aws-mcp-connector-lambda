import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "../context";
import { HOST_RE, PREFIX_RE } from "./region-origins";

/**
 * A SECONDARY pod that hands out its file links on the PRIMARY's files host
 * (`filesPublicHost`, phase 2 of region-origins.ts — the consumer side).
 *
 * The files distribution exists once per account and stays the primary's
 * (`filesDomain`, still refused on a secondary pod — pod-topology.ts). Once the
 * primary lists this pod in its `filesRegionOrigins`, that distribution serves
 * this pod's presigned URLs, its transfer page's form POST and its `/_t`
 * lookup. All this pod then needs is the host's NAME:
 *   - `FILES_PUBLIC_HOST` on the connector, which swaps the host of each
 *     presigned URL of its own bucket and offers the browser fallback link;
 *   - nothing else: no distribution, certificate, record, function, grant or
 *     bucket policy. The authorization of a link is its signature, made by this
 *     pod's own role for its own bucket.
 * The output `FilesRegionOrigin` is the exact entry the primary's
 * `filesRegionOrigins` takes for this pod.
 *
 * ORDER MATTERS at rollout: the primary must already list this pod, or every
 * link this pod emits answers 403 (the default behavior fronts the primary's
 * bucket). Removing the parameter is the rollback: links name S3 again.
 *
 * Absent parameter -> nothing is read, nothing is emitted, every template is
 * byte-identical (scripts/synth-golden.ts).
 */
export const PARAM = "filesPublicHost";

export function consumeFilesPublicHost(stack: cdk.Stack, ctx: StackContext): void {
  const host = process.env[PARAM];
  if (!host) return;
  const fail = (m: string): never => {
    throw new Error(`${PARAM}: ${m}`);
  };
  // The pod that owns the distribution names it with filesDomain, which sets
  // the same variable: two sources for one value are refused, not ranked.
  if (process.env["filesDomain"]) fail("cannot be set with filesDomain (the pod that owns the files distribution already hands out its host)");
  if (!ctx.skipGlobalResources) {
    fail("is for a SECONDARY pod (skipGlobalResources=true); a primary pod names its files host with filesDomain");
  }
  // A bare DNS name: lowercase, at least two labels, no scheme, path, port or
  // space. The connector writes it between "https://" and "/" as is.
  if (host.length > 253 || !HOST_RE.test(host)) {
    fail("must be a bare lowercase DNS name (no scheme, path, port or space), e.g. files.example.eu");
  }
  if (host === ctx.originDomain || host === ctx.customDomain) {
    fail("must be the files host, not one of this pod's API names");
  }
  // What the primary routes this pod's links BY. Without a storage prefix the
  // keys start with nothing the path could be told apart with, and the primary
  // refuses any other shape (region-origins.ts): fail here, not on a live link.
  const bucketName = ctx.plainEnv["bucketName"];
  const prefix = ctx.plainEnv["s3Prefix"];
  if (!bucketName) fail("hereyaProjectEnv carries no bucketName (hereya/aws-file-storage)");
  if (!prefix || !PREFIX_RE.test(prefix)) {
    fail("the pod's storage prefix (s3Prefix in hereyaProjectEnv) must be one path segment of letters, digits and dashes: the primary routes this pod's links by it");
  }

  ctx.fn.addEnvironment("FILES_PUBLIC_HOST", host);
  new cdk.CfnOutput(stack, "FilesRegionOrigin", {
    description: "This pod's entry for the primary's filesRegionOrigins",
    value: `${stack.region}:${ctx.originDomain}:${bucketName}.s3.${stack.region}.amazonaws.com:${prefix}`,
  });
}
