import * as cdk from "aws-cdk-lib/core";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { StackContext } from "../context";

export function resolveAppContentDomain(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentCertArn, appContentZoneId } = ctx;
  // Called only from inside `if (appContentDomain)`.
  const appContentDomain = ctx.appContentDomain!;
  if (!appContentCertArn) {
    throw new Error(
      "appContentCertArn is required when appContentDomain is set"
    );
  }
  if (!appContentZoneId) {
    throw new Error(
      "appContentZoneId is required when appContentDomain is set"
    );
  }

  // Pre-created us-east-1 wildcard cert (passed in, NOT created by CDK).
  const appContentCertificate = acm.Certificate.fromCertificateArn(
    stack,
    "AppContentCertificate",
    appContentCertArn
  );

  // Attribute import (no context lookup) — the zone for appContentDomain.
  const appContentZone = route53.HostedZone.fromHostedZoneAttributes(
    stack,
    "AppContentZone",
    { hostedZoneId: appContentZoneId, zoneName: appContentDomain }
  );

  // Host map = DATA, not code (2026-07-19): a CloudFront KeyValueStore
  // holds one key per vanity/BYOD host (`<host>` -> `{"o":"<orgId>",
  // "a":"<app>"}`). The connector adds/removes KEYS at provisioning —
  // the function CODE below never carries tenant state, so deploys that
  // change the body can never reset the routing table (the historical
  // `var HOSTMAP = {…};` byte-swap pattern is gone).
  ctx.appContentCertificate = appContentCertificate;
  ctx.appContentZone = appContentZone;
}