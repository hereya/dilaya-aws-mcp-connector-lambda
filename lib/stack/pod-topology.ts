/**
 * Regional pods (Région Canada, t_rca_p0_infra). Both inputs are OPTIONAL and
 * absent in today's single-pod deployment, where the stack synthesizes
 * byte-for-byte what it did before they existed (scripts/synth-golden.ts).
 *
 * `originDomain` decouples the PUBLIC name from the host this pod OWNS.
 *   - Public (`customDomain`, e.g. app.dilaya.eu, and the plugin host
 *     `mcp.<zone>`): still what the pod ACCEPTS and ADVERTISES — the authorizer
 *     audience https://<customDomain>/mcp, the PRM resource, the URLs the
 *     connector builds (its `customDomain` env), and — on a PRIMARY pod — the
 *     per-app Lambda prefix (a secondary one names it from originDomain:
 *     project-env.ts, the prefix names account-global IAM roles).
 *   - Owned (`originDomain`, e.g. eu.app.dilaya.eu / ca.app.dilaya.eu): the ONLY
 *     API Gateway custom domain + Route 53 record this pod creates. The public
 *     names then belong to the front door that routes each org to its pod —
 *     so the pod creates NEITHER the customDomain NOR the mcp.<zone>
 *     domain/record. The app-content edge (if any) fronts this origin.
 *
 * `originAlias` (t_rca_p1_router step 5) is the PRIMARY pod's origin host
 * (e.g. app-eu.dilaya.eu, the region router's home origin) owned NEXT TO the
 * public names, not instead of them: `originDomain` would drop app.dilaya.eu
 * and mcp.<zone> on deploy, before the DNS switch. With the alias the cutover is
 * a DNS change, reversible in a minute.
 *
 * `skipGlobalResources=true` marks a SECONDARY pod: one that must not recreate
 * anything that exists once per account (global CloudFront names, us-east-1
 * certs, account-wide DNS names, BYOD distribution rewrites). It requires
 * `originDomain` (otherwise the pod would recreate the public record) and
 * refuses the edge features that are once-per-account by construction
 * (`appContentDomain`, `filesDomain`) instead of dropping them silently; it
 * also skips the legacy Cognito frontend distribution (`*.<customDomain>`).
 */
export interface PodTopology {
  originDomain: string | undefined;
  originAlias: string | undefined;
  skipGlobalResources: boolean;
}

export function readPodTopology(
  env: NodeJS.ProcessEnv,
  customDomain: string | undefined,
  customDomainZone: string | undefined,
  mcpDomain: string | undefined
): PodTopology {
  const originDomain = env["originDomain"] || undefined;
  const skipGlobalResources = env["skipGlobalResources"] === "true";
  const originAlias = env["originAlias"] || undefined;

  if (originDomain) {
    if (!customDomain || !customDomainZone) {
      throw new Error("originDomain requires customDomain (the public name it stands behind)");
    }
    if (originDomain === customDomain || originDomain === mcpDomain) {
      throw new Error(`originDomain must differ from the public names; got ${originDomain}`);
    }
    // The pod's record goes into the customDomain hosted zone (the one it
    // already looks up); a name outside it would need a zone this stack has
    // no handle on.
    if (!originDomain.endsWith(`.${customDomainZone}`)) {
      throw new Error(
        `originDomain (${originDomain}) must sit in the customDomain zone ${customDomainZone}`
      );
    }
  }

  if (originAlias) {
    if (originDomain) {
      throw new Error("originAlias is for a pod that owns its public names; with originDomain the pod already owns only its origin host");
    }
    if (!customDomain || !customDomainZone) {
      throw new Error("originAlias requires customDomain (the public name it stands next to)");
    }
    if (originAlias === customDomain || originAlias === mcpDomain) {
      throw new Error(`originAlias must differ from the public names; got ${originAlias}`);
    }
    if (!originAlias.endsWith(`.${customDomainZone}`)) {
      throw new Error(`originAlias (${originAlias}) must sit in the customDomain zone ${customDomainZone}`);
    }
  }

  if (skipGlobalResources) {
    if (!originDomain) {
      throw new Error(
        "skipGlobalResources=true requires originDomain: a secondary pod owns only its origin host"
      );
    }
    for (const k of ["appContentDomain", "filesDomain"]) {
      if (env[k]) {
        throw new Error(
          `${k} is a once-per-account edge resource and cannot be set with skipGlobalResources=true`
        );
      }
    }
  }

  return { originDomain, originAlias, skipGlobalResources };
}
