import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  type FilesRegionOrigin,
  regionKeyPattern,
  regionMaterialPath,
  regionUploadPath,
  rewriteFunctionCode,
} from "./region-origins";

/** The pass-through settings of the default behavior, minus its origin (files-domain.ts). */
export type PassThrough = Omit<cloudfront.BehaviorOptions, "origin">;

/**
 * The three behaviors of each region (region-origins.ts), to be appended AFTER the fixed ones.
 * Every pattern here is disjoint from the others and from `/_transfer*` and `/_t`, so their order
 * decides nothing; a key of the pod's own bucket starts with another prefix and falls through to
 * the default behavior. An empty list returns `{}` and creates no construct at all.
 *
 * The bucket origin is the default one's twin: an S3 origin WITHOUT OAC/OAI and the same
 * pass-through settings, so a presigned signature verifies exactly as it does for the home bucket.
 */
export function regionBehaviors(
  stack: cdk.Stack,
  regions: FilesRegionOrigin[],
  passThrough: PassThrough
): Record<string, cloudfront.BehaviorOptions> {
  const out: Record<string, cloudfront.BehaviorOptions> = {};
  if (regions.length === 0) return out;

  const rewrite = (id: string, target: "/" | "/_t", comment: string): cloudfront.FunctionAssociation[] => [
    {
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      function: new cloudfront.Function(stack, id, {
        comment,
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(rewriteFunctionCode(target)),
      }),
    },
  ];
  // Two functions for every region: the target is a constant, the region lives in the behavior.
  const toRoot = rewrite("FilesRegionUploadRewrite", "/", "Files host: /_u/<region> -> / (form POST to a region's bucket)");
  const toMaterial = rewrite("FilesRegionMaterialRewrite", "/_t", "Files host: /_t/<region> -> /_t (a region's connector)");

  for (const r of regions) {
    const bucket = s3.Bucket.fromBucketAttributes(stack, `FilesBucket-${r.region}`, {
      bucketName: r.bucketDomain.split(".s3.")[0]!,
      bucketRegionalDomainName: r.bucketDomain,
      region: r.region,
    });
    const bucketOrigin = origins.S3BucketOrigin.withBucketDefaults(bucket);
    const podOrigin = new origins.HttpOrigin(r.host, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    out[regionMaterialPath(r.region)] = { origin: podOrigin, ...passThrough, functionAssociations: toMaterial };
    out[regionUploadPath(r.region)] = { origin: bucketOrigin, ...passThrough, functionAssociations: toRoot };
    out[regionKeyPattern(r.prefix)] = { origin: bucketOrigin, ...passThrough };
  }
  return out;
}
