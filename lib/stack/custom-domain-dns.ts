import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { StackContext } from "./context";

export function createCustomDomainDns(stack: cdk.Stack, ctx: StackContext): void {
  const { fn, httpApi } = ctx;
  // Called only from inside `if (customDomain && customDomainZone)`, which also
  // throws when the wildcard cert is missing — hence the three assertions.
  const customDomain = ctx.customDomain!;
  const customDomainZone = ctx.customDomainZone!;
  const wildcardCertificateArn = ctx.wildcardCertificateArn!;
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "Certificate",
    wildcardCertificateArn
  );

  const hostedZone = route53.HostedZone.fromLookup(stack, "HostedZone", {
    domainName: customDomainZone,
  });

  // Expose hosted zone ID + grant Route53 record-set management so the
  // org Lambda can write DKIM + return-path records when provisioning
  // per-app Postmark domains via enable-auth.
  fn.addEnvironment("HOSTED_ZONE_ID", hostedZone.hostedZoneId);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
        "route53:GetHostedZone",
      ],
      resources: [
        `arn:aws:route53:::hostedzone/${hostedZone.hostedZoneId}`,
      ],
    })
  );

  // API Gateway custom domain for MCP (exact domain). With originDomain
  // (pod-topology.ts) the pod owns its ORIGIN host instead of the public one.
  const ownedDomain = ctx.originDomain ?? customDomain;
  const domainName = new apigwv2.DomainName(stack, "DomainName", {
    domainName: ownedDomain,
    certificate,
  });

  new apigwv2.ApiMapping(stack, "ApiMapping", {
    api: httpApi,
    domainName,
  });

  new route53.ARecord(stack, "AliasRecord", {
    zone: hostedZone,
    recordName: ownedDomain,
    target: route53.RecordTarget.fromAlias(
      new targets.ApiGatewayv2DomainProperties(
        domainName.regionalDomainName,
        domainName.regionalHostedZoneId
      )
    ),
  });

  // The plugin host (t_skills_plugin_path): `mcp.<zone>` mapped on the SAME
  // API — same routes, same authorizer — so MCP answers at its root (`POST /`,
  // routes.ts). The wildcard cert covers it; the specific record wins over the
  // zone's `*` record. The connector reads MCP_DOMAIN to serve that host its
  // own tool surface (no text-recipe tools: those ship as plugin skills).
  // Behind an originDomain the plugin host is the front door's, like the
  // public name: still advertised (MCP_DOMAIN, audience, root route), not owned.
  if (ctx.mcpDomain && !ctx.originDomain) {
    const mcpDomainName = new apigwv2.DomainName(stack, "McpDomainName", {
      domainName: ctx.mcpDomain,
      certificate,
    });
    new apigwv2.ApiMapping(stack, "McpApiMapping", { api: httpApi, domainName: mcpDomainName });
    new route53.ARecord(stack, "McpAliasRecord", {
      zone: hostedZone,
      recordName: ctx.mcpDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          mcpDomainName.regionalDomainName,
          mcpDomainName.regionalHostedZoneId
        )
      ),
    });
  }
  if (ctx.mcpDomain) {
    fn.addEnvironment("MCP_DOMAIN", ctx.mcpDomain);
  }

  // -------------------------------------------------------------------
  // App-content domain: host-routing (FLAT scheme) — additive vanity host.
  //
  // A dedicated CloudFront distribution (alt name `*.<appContentDomain>`,
  // wildcard viewer cert) fronts the SAME API-Gateway custom-domain origin
  // (`customDomain`, e.g. app.dilaya.eu) that the path URL already uses — the
  // origin Host stays `customDomain` so API-GW domain/routing still matches.
  // A CloudFront FUNCTION (viewer-request) holds a BAKED host->{org,app} map
  // and rewrites the URI to the existing per-app site/auth routes
  // (/o/<org>/<app>/{site|auth}/…), tagging the viewer host in the
  // `x-dilaya-app-host` header. The connector regenerates the map at runtime
  // via UpdateFunction/PublishFunction — ONLY the `var HOSTMAP = {};` object
  // literal is swapped, so keep the surrounding source byte-stable. The cert
  // + wildcard DNS are static (one label under the domain) and never change
  // as apps/orgs are added. Entire feature is gated on `appContentDomain`.
  // -------------------------------------------------------------------

  // The primary pod's origin host NEXT TO the public names (originAlias,
  // pod-topology.ts): the region router's home origin. Additive only — the
  // resources above keep their logical ids, so adding it replaces nothing.
  if (ctx.originAlias) {
    const aliasDomainName = new apigwv2.DomainName(stack, "OriginAliasDomainName", {
      domainName: ctx.originAlias,
      certificate,
    });
    new apigwv2.ApiMapping(stack, "OriginAliasApiMapping", { api: httpApi, domainName: aliasDomainName });
    new route53.ARecord(stack, "OriginAliasRecord", {
      zone: hostedZone,
      recordName: ctx.originAlias,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          aliasDomainName.regionalDomainName,
          aliasDomainName.regionalHostedZoneId
        )
      ),
    });
  }

  ctx.certificate = certificate;
  ctx.domainName = domainName;
  ctx.hostedZone = hostedZone;
}