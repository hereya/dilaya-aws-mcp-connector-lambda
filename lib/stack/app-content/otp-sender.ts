import * as cdk from "aws-cdk-lib/core";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { StackContext } from "../context";

// Login codes (OTP) of every app without a custom domain leave from ONE
// warmed sender, `noreply@<appContentDomain>`, under the app's display name
// (t_app_login_first_code, 07/10). A brand-new per-app sender domain made
// iCloud defer the FIRST code ~3 min and file it as spam. The Postmark
// signature for the apex is provisioned by the connector at enable-auth.
//
// DMARC on the content domain: no record at all counted against every sender
// under it (subdomains inherit `p` through the organizational domain).
export const DMARC_VALUE = "v=DMARC1; p=none; adkim=r; aspf=r";

export function createOtpSender(stack: cdk.Stack, ctx: StackContext): void {
  // Called only from inside `if (appContentDomain)`, after resolveAppContentDomain.
  const appContentDomain = ctx.appContentDomain!;
  new route53.TxtRecord(stack, "AppContentDmarc", {
    zone: ctx.appContentZone,
    recordName: `_dmarc.${appContentDomain}.`,
    values: [DMARC_VALUE],
    ttl: cdk.Duration.minutes(5),
  });
  ctx.authLambdaFn?.addEnvironment("OTP_SENDER_DOMAIN", appContentDomain);
}
