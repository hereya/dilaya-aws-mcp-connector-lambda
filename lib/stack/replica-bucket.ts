import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "./context";

/**
 * The connector's access to its pod's SQLite REPLICA bucket (Région CA P2 lot 3,
 * t_rca_p2_migrate, option a). The org-move `db` family copies each database's
 * Litestream replica (`<org>/<app>/app.db/…`) from the EU bucket to the CA one
 * over the admin-peer channel (connector src/region-migrate/copy/):
 *
 *   PRIMARY pod (the source; also a single-region deployment) — READ ONLY:
 *     ListObjectsV2 (s3:ListBucket) + GetObject / HeadObject (s3:GetObject),
 *     then streams the bytes to URLs the target presigned.
 *   SECONDARY pod (the target) — its own bucket:
 *     ListObjectsV2 (s3:ListBucket) to diff what it holds;
 *     HeadObject (s3:GetObject) on a MULTIPART object only, to read the source
 *       fingerprint in its `dilaya-src-fp` metadata (target-store.ts `finish`);
 *     presigned PutObject / UploadPart + Create/CompleteMultipartUpload (s3:PutObject);
 *     DeleteObject (an object gone at the source); AbortMultipartUpload.
 *
 * The bucket NAME is the `dilaya/aws-sqlite-data` output `sqliteReplicaBucketName`,
 * a plain value at synth. The grant is written HERE, on the main connector
 * Lambda's role only: a dependency `iamPolicy*` output would also reach the auth
 * Lambda and the site authorizer. SSE-S3 (AES256) on both buckets: no KMS.
 * Inert without the bucket name and on a legacy single-org deployment
 * (organizationId) — the region move is multi-tenant only.
 */
export function grantReplicaBucket(_stack: cdk.Stack, ctx: StackContext): void {
  const bucket = ctx.plainEnv["sqliteReplicaBucketName"];
  if (!bucket || ctx.organizationId) return;
  if (!BUCKET_RE.test(bucket)) {
    throw new Error(`sqliteReplicaBucketName must be an S3 bucket name; got ${bucket}`);
  }
  for (const s of replicaBucketStatements(`arn:aws:s3:::${bucket}`, ctx.skipGlobalResources)) {
    ctx.fn.addToRolePolicy(s);
  }
}

/** The statements, per pod role (exported for the tests). */
export function replicaBucketStatements(bucketArn: string, secondary: boolean): iam.PolicyStatement[] {
  const list = new iam.PolicyStatement({ actions: ["s3:ListBucket"], resources: [bucketArn] });
  const objects = secondary
    ? ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    : ["s3:GetObject"];
  return [list, new iam.PolicyStatement({ actions: objects, resources: [`${bucketArn}/*`] })];
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
