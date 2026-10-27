/**
 * The REGION ROUTER (Région Canada P1, t_rca_p1_router): the front door that keeps ONE public
 * URL (https://app.dilaya.eu/mcp, and the plugin host mcp.<zone>) in front of every regional pod.
 * The region is a property of the ORG; the front door picks the pod's origin per request:
 *
 *   - a CloudFront Function (viewer-request) decodes the bearer's `org_ids` (ROUTING ONLY — the
 *     token is never trusted here; the pod's authorizer still validates it), looks each org up in a
 *     KeyValueStore (org id → region) and, when they all live in one region, points the request
 *     at that region's origin. A `/o/<orgId>/…` path routes by the org it names;
 *   - a Lambda@Edge (origin-request, us-east-1) settles the rest — a token whose orgs sit in
 *     DIFFERENT regions — by reading `params.arguments.org` from the JSON-RPC body (bounded read);
 *     absent, unknown, unreadable → the HOME region.
 *
 * Named "region router", not "front door": that name already belongs to the static site routes
 * of t_app_routing_o1 (front-door.ts, FRONT_DOOR_ROUTES).
 *
 * Every input is OPTIONAL and absent in today's deployment, where the template is byte-identical
 * to the one before this file existed (scripts/synth-golden.ts + the release.yml synth).
 *
 *   regionRouter=true            creates the distribution, the function, the KVS
 *   regionRouterOrigins          "eu-west-1:app-eu.dilaya.eu,ca-central-1:app-ca.dilaya.eu" —
 *                                region:host pairs (":" because hereya cuts a -p at every "="),
 *                                the FIRST one is the home region
 *   regionRouterCertArn          us-east-1 ACM cert covering customDomain + mcp.<zone>
 *   regionRouterEdgeVersionArn   a published Lambda@Edge VERSION (us-east-1) — passed in like the
 *                                us-east-1 certs: this stack lives in the pod's region and the
 *                                package's single-stack deploy cannot create it (edge-stack.ts).
 *                                Absent (the chosen shape, step-5 trial 27/10/2026: any origin-request
 *                                Lambda@Edge costs +64 ms on EVERY request) → mixed-region tokens go
 *                                home and the home connector relays (REGION_ROUTER_ORIGINS)
 *   regionRouterOriginSecret     stamped by the distribution as x-dilaya-region-verify; a pod that
 *                                has it (primary OR secondary) honours x-dilaya-viewer-host — and
 *                                only when the request proves the secret (pod-trust.ts)
 */
export const VIEWER_HOST_HEADER = "x-dilaya-viewer-host";
export const REGION_VERIFY_HEADER = "x-dilaya-region-verify";
export const ROUTE_HEADER = "x-dilaya-route";
export const ORG_REGIONS_HEADER = "x-dilaya-org-regions";
export const POD_SECRET_ENV = "REGION_ROUTER_ORIGIN_SECRET";

export interface RegionRouterConfig {
  /** The region an unknown / unroutable request goes to — the first origin listed. */
  home: string;
  /** region → origin host, in the order given. */
  origins: Record<string, string>;
  certArn: string;
  edgeVersionArn: string | undefined;
  originSecret: string;
  /** regionRouterPublicDns=true: the public names' DNS points at the distribution (the cutover). */
  publicDns: boolean;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CERT_RE = /^arn:aws:acm:us-east-1:\d{12}:certificate\/[\w-]+$/;
const EDGE_RE = /^arn:aws:lambda:us-east-1:\d{12}:function:[\w-]+:\d+$/;
// Printable ASCII without "=" (hereya cuts a -p at the first "=": a base64 pad would be lost).
const SECRET_RE = /^[\x21-\x3c\x3e-\x7e]{32,256}$/;

/** "eu-west-1:app-eu.dilaya.eu,…" → { "eu-west-1": "app-eu.dilaya.eu", … }, validated. */
export function parseOrigins(raw: string, publicNames: string[]): Record<string, string> {
  const origins: Record<string, string> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    const region = entry.slice(0, i);
    const host = entry.slice(i + 1).toLowerCase();
    if (i < 1 || !REGION_RE.test(region) || !HOST_RE.test(host)) {
      throw new Error(`regionRouterOrigins: "${entry}" is not <region>:<host>`);
    }
    if (origins[region]) throw new Error(`regionRouterOrigins: region ${region} listed twice`);
    if (publicNames.includes(host)) {
      throw new Error(`regionRouterOrigins: ${host} is a PUBLIC name; an origin must be a pod's own host`);
    }
    origins[region] = host;
  }
  if (Object.keys(origins).length === 0) throw new Error("regionRouterOrigins: no origin given");
  return origins;
}

export function readRegionRouter(
  env: NodeJS.ProcessEnv,
  customDomain: string | undefined,
  mcpDomain: string | undefined,
  skipGlobalResources: boolean
): { config: RegionRouterConfig | undefined; originSecret: string | undefined } {
  const originSecret = env["regionRouterOriginSecret"] || undefined;
  if (originSecret && !SECRET_RE.test(originSecret)) {
    throw new Error("regionRouterOriginSecret must be 32-256 printable ASCII characters, without '='");
  }
  if (env["regionRouter"] !== "true") {
    for (const k of ["regionRouterOrigins", "regionRouterCertArn", "regionRouterEdgeVersionArn", "regionRouterPublicDns"]) {
      if (env[k]) throw new Error(`${k} is set but regionRouter is not "true"`);
    }
    return { config: undefined, originSecret };
  }

  if (!customDomain) throw new Error("regionRouter=true requires customDomain (the public name it fronts)");
  if (skipGlobalResources) {
    throw new Error("regionRouter is once per account (global CloudFront names): not on a secondary pod");
  }
  if (!originSecret) throw new Error("regionRouter=true requires regionRouterOriginSecret");
  const origins = parseOrigins(env["regionRouterOrigins"] ?? "", [customDomain, ...(mcpDomain ? [mcpDomain] : [])]);
  const certArn = env["regionRouterCertArn"] ?? "";
  if (!CERT_RE.test(certArn)) throw new Error("regionRouterCertArn must be a us-east-1 ACM certificate ARN");
  const edgeVersionArn = env["regionRouterEdgeVersionArn"] || undefined;
  if (edgeVersionArn && !EDGE_RE.test(edgeVersionArn)) {
    throw new Error("regionRouterEdgeVersionArn must be a numbered us-east-1 Lambda version ARN");
  }
  return {
    config: {
      home: Object.keys(origins)[0],
      origins,
      certArn,
      edgeVersionArn,
      originSecret,
      publicDns: env["regionRouterPublicDns"] === "true",
    },
    originSecret,
  };
}
