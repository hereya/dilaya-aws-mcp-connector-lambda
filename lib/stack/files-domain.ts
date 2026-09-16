import * as cdk from "aws-cdk-lib/core";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { StackContext } from "./context";
import { CLOUDFRONT_FUNCTION_MAX_BYTES } from "./app-content/router-stop-pages";
import { TRANSFER_PATH, transferFunctionCode } from "./files-transfer/page";

/**
 * Presigned file URLs on a Dilaya host (t_files_own_domain, 2026-09-12).
 *
 * The connector's presigned URLs named `<bucket>.s3.<region>.amazonaws.com`,
 * a domain some sandboxed environments (Claude Cowork, ChatGPT work) block.
 * This puts a plain pass-through distribution in front of the file bucket, and
 * the connector swaps ONLY the host of each URL for `filesDomain`.
 *
 * Nothing is re-signed. A presigned SigV4 URL covers `Host`, and it still
 * verifies because CloudFront always sends an S3 origin the origin's own host —
 * a viewer's Host never reaches S3. So the distribution must stay exactly this:
 *   - an S3 origin WITHOUT OAC/OAI: the authorization travels in the query
 *     string and S3 still decides (a tampered signature answers 403 through the
 *     distribution — proven), the bucket stays private;
 *   - every query string and viewer header forwarded EXCEPT Host;
 *   - no caching: every URL is unique and short-lived;
 *   - every method, since uploads are PUT (and multipart is POST).
 * Proven end to end on throwaway resources before any of this was written:
 * GET, PUT 1 KB, PUT 150 MB over 77 s, multipart — all 200.
 *
 * Optional and additive: absent `filesDomain` → nothing is created and the
 * connector keeps handing out S3 hosts. The certificate is passed in (us-east-1,
 * validated outside the stack) like the app-content one.
 */
export function createFilesDomain(stack: cdk.Stack, ctx: StackContext): void {
  const filesDomain = process.env["filesDomain"];
  if (!filesDomain) return;
  const filesZoneId = process.env["filesZoneId"];
  const filesCertArn = process.env["filesCertArn"];
  if (!filesZoneId) {
    throw new Error("filesZoneId is required when filesDomain is set");
  }
  if (!filesCertArn) {
    throw new Error("filesCertArn is required when filesDomain is set");
  }
  // The shared bucket comes from hereya/aws-file-storage, the same value the
  // connector presigns against. A distribution in front of another bucket
  // would hand out links that can only ever answer 403.
  const bucketName = ctx.plainEnv["bucketName"];
  if (!bucketName) {
    throw new Error(
      "filesDomain is set but hereyaProjectEnv carries no bucketName (hereya/aws-file-storage)"
    );
  }

  const bucket = s3.Bucket.fromBucketName(stack, "FilesBucket", bucketName);
  const origin = origins.S3BucketOrigin.withBucketDefaults(bucket);
  const transferFn = createTransferPageFunction(stack);
  const distribution = new cloudfront.Distribution(stack, "FilesDistribution", {
    comment: "Presigned file URLs on a Dilaya host (pass-through to S3)",
    certificate: acm.Certificate.fromCertificateArn(
      stack,
      "FilesCertificate",
      filesCertArn
    ),
    domainNames: [filesDomain],
    defaultBehavior: {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    },
    // The human transfer page (t_dad9f0e09ffb) on the SAME host as the
    // presigned URLs. Its function answers every request itself, so the bucket
    // is never asked for this path (the origin is only required by the API).
    // No object key can collide: every key starts with the storage prefix.
    additionalBehaviors: {
      [`${TRANSFER_PATH}*`]: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [
          { function: transferFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    },
  });

  const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "FilesZone", {
    hostedZoneId: filesZoneId,
    zoneName: filesDomain.split(".").slice(1).join("."),
  });
  const target = route53.RecordTarget.fromAlias(
    new targets.CloudFrontTarget(distribution)
  );
  new route53.ARecord(stack, "FilesAliasA", { zone, recordName: filesDomain, target });
  new route53.AaaaRecord(stack, "FilesAliasAAAA", { zone, recordName: filesDomain, target });

  ctx.fn.addEnvironment("FILES_PUBLIC_HOST", filesDomain);
  new cdk.CfnOutput(stack, "FilesDistributionDomain", {
    value: distribution.distributionDomainName,
  });
}

function createTransferPageFunction(stack: cdk.Stack): cloudfront.Function {
  const code = transferFunctionCode();
  if (Buffer.byteLength(code, "utf8") > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error("files transfer page function exceeds the CloudFront 10 KB code limit");
  }
  return new cloudfront.Function(stack, "FilesTransferPage", {
    comment: "Human upload/download fallback page (bytes go straight to S3)",
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    code: cloudfront.FunctionCode.fromInline(code),
  });
}
