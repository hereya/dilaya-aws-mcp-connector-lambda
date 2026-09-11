import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import type { StackContext } from "../context";

export function grantDomainPurchase(stack: cdk.Stack, ctx: StackContext): void {
  const { domainPurchase, fn } = ctx;
  if (domainPurchase) {
    fn.addEnvironment("DOMAIN_PURCHASE_ENABLED", "true");
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "route53domains:CheckDomainAvailability",
          "route53domains:ListPrices",
          "route53domains:RegisterDomain",
          "route53domains:GetDomainDetail",
          "route53domains:GetOperationDetail",
          "route53domains:ListDomains",
          "route53domains:ListOperations",
          "route53domains:GetContactReachabilityStatus",
          "route53domains:ResendContactReachabilityEmail",
          "route53domains:EnableDomainAutoRenew",
          "route53domains:DisableDomainAutoRenew",
          // LEAVING is a customer right, so the connector must be able to
          // hand a customer the key to their own name: the authorization
          // code, and the lock that stands in front of it. Neither ever
          // reaches an agent's context — the code is emailed to the
          // registrant on file (dilaya.eu sends; nothing returns it to a
          // tool caller), and the two are deliberately SEPARATE gestures
          // so a single click can never start a transfer on its own.
          // The API — and therefore the IAM action — is RETRIEVE, not
          // "Get". A policy naming a non-existent action is accepted by
          // IAM and grants NOTHING, silently: no synth, no typecheck and
          // no unit test can see it. Only the SDK's own command name
          // (RetrieveDomainAuthCodeCommand) betrays it.
          "route53domains:RetrieveDomainAuthCode",
          "route53domains:EnableDomainTransferLock",
          "route53domains:DisableDomainTransferLock",
        ],
        resources: ["*"],
      })
    );
    // Each purchased domain lands as a NEW hosted zone in this account —
    // and RegisterDomain creates that zone WITH THE CALLER'S credentials,
    // so the connector needs route53:CreateHostedZone itself (proven by
    // the first live purchase: AccessDenied on exactly that action; the
    // registration is refused BEFORE any charge). The connector then
    // discovers the zone (ListHostedZonesByName) and writes the
    // custom-domain records there itself (managed-zone mode: validation
    // CNAMEs, routing incl. the apex ALIAS, DKIM/return-path). Zones
    // that don't exist at deploy time can't be enumerated, so these
    // grants are wildcard; the connector only ever addresses zones
    // matching its own domainorder# rows.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "route53:CreateHostedZone",
          "route53:ListHostedZonesByName",
          // CreateHostedZone returns a change id the service polls.
          "route53:GetChange",
        ],
        resources: ["*"],
      })
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
          "route53:GetHostedZone",
        ],
        resources: ["arn:aws:route53:::hostedzone/*"],
      })
    );
  }

}