import * as cdk from "aws-cdk-lib/core";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { StackContext } from "../context";

export function createSubdomainRewrite(stack: cdk.Stack, ctx: StackContext): void {
  const { customDomain, domainName, hostedZone } = ctx;
        const cloudfrontCertificate = new acm.DnsValidatedCertificate(
          stack,
          "CloudFrontCertificate",
          {
            domainName: `*.${customDomain}`,
            hostedZone,
            region: "us-east-1",
          }
        );

        // CloudFront Function: extract app subdomain → prepend to path, and
        // (when the org Lambda regenerates the code) route custom vanity
        // domains via a per-host domainMap lookup.
        //
        // This inline code is the BOOTSTRAP version with an empty domainMap.
        // On the first `set-custom-domains`/`check-custom-domains` cycle the
        // org Lambda overwrites this function with a regenerated version that
        // contains the active domain→schema mapping. The shape must match
        // src/custom-domain-template.ts in the hereya-apps repo so runtime
        // updates are drop-in replacements.
        const cfFunction = new cloudfront.Function(stack, "SubdomainRewrite", {
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var customDomain = ${JSON.stringify(customDomain)};
  var domainMap = {};
  if (domainMap[host]) {
    request.uri = '/' + domainMap[host] + request.uri;
    return request;
  }
  if (host !== customDomain && host.endsWith('.' + customDomain)) {
    var appName = host.slice(0, -(customDomain.length + 1));
    request.uri = '/' + appName + request.uri;
  }
  return request;
}
          `),
          functionName: `${stack.stackName}-subdomain-rewrite`,
        });
  ctx.cfFunction = cfFunction;
  ctx.cloudfrontCertificate = cloudfrontCertificate;
}