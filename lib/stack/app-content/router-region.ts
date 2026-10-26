/**
 * The app-content router's REGION branch (Région Canada, t_rca_p1_router step 4, gap 1).
 *
 * The host-map KVS is ONE store for every region (CloudFront is global). A pod other than the
 * home one tags what it writes: a host entry carries `"g":"<region>"` (dilaya-connector
 * src/custom-domains/kvs-region.ts). Until now the router ignored `g`, so a site whose org lives
 * in Montréal would have been served from the EU pod and the EU bucket. With
 * `appContentRegionOrigins` the router sends such a host to ITS region instead:
 *   - dynamic paths (site, /auth, /api) → that pod's own API host (`originDomain`, e.g.
 *     app-ca.dilaya.eu) — only the domain is swapped, so the distribution's origin-lock header
 *     (x-dilaya-origin-verify) follows the request;
 *   - /static/* and static sections → that region's static-assets bucket, OAC-signed like the
 *     home bucket (the bucket policy must admit this account's distributions).
 * A `g` the router has no origin for is answered 503 at the edge — never served from the wrong
 * region. Absent parameter → none of this is emitted and the function is byte-identical.
 *
 *   appContentRegionOrigins  "ca-central-1:app-ca.dilaya.eu:<bucket>.s3.ca-central-1.amazonaws.com"
 *                            region:host:bucket-regional-domain, comma-separated (":" because
 *                            hereya cuts a -p at every "=")
 */
export interface RegionOrigin {
  /** The pod's own API host (its originDomain). */
  h: string;
  /** The region's static-assets bucket, regional domain name. */
  b: string;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BUCKET_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.([a-z]{2}(-[a-z]+)+-\d)\.amazonaws\.com$/;

/** Parse + validate the parameter; undefined when absent. */
export function parseRegionOrigins(
  raw: string | undefined,
  homeRegion: string | undefined
): Record<string, RegionOrigin> | undefined {
  if (!raw) return undefined;
  const out: Record<string, RegionOrigin> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [region, host, bucket, ...rest] = entry.toLowerCase().split(":");
    const bm = BUCKET_DOMAIN_RE.exec(bucket ?? "");
    if (rest.length || !REGION_RE.test(region ?? "") || !HOST_RE.test(host ?? "") || !bm) {
      throw new Error(`appContentRegionOrigins: "${entry}" is not <region>:<host>:<bucket>.s3.<region>.amazonaws.com`);
    }
    if (bm[1] !== region) throw new Error(`appContentRegionOrigins: bucket ${bucket} is not in ${region}`);
    if (region === homeRegion) throw new Error(`appContentRegionOrigins: ${region} is the home region`);
    if (out[region]) throw new Error(`appContentRegionOrigins: region ${region} listed twice`);
    out[region] = { h: host!, b: bucket! };
  }
  if (Object.keys(out).length === 0) throw new Error("appContentRegionOrigins: no origin given");
  return out;
}

/** The source fragments the router splices in; every one is "" (or the home literal) when off. */
export interface RegionPieces {
  prelude: string;
  branch: string;
  staticAssets: string;
  bucketExpr: string;
  dynamic: string;
}

export function regionPieces(
  regions: Record<string, RegionOrigin> | undefined,
  staticBucketDomain: string
): RegionPieces {
  const home = `"${staticBucketDomain}"`;
  if (!regions) return { prelude: "", branch: "", staticAssets: "", bucketExpr: home, dynamic: "" };
  return {
    prelude: `var REGIONS = ${JSON.stringify(regions)};
function toBucket(b) {
  cf.updateRequestOrigin({
    "domainName": b,
    "originAccessControlConfig": { "enabled": true, "signingBehavior": "always", "signingProtocol": "sigv4", "originType": "s3" },
    "customHeaders": {}
  });
}
`,
    branch: `  // REGION (value flag g, router-region.ts): the org lives in another region.
  // Its pod and its bucket serve it; a region with no origin here -> 503.
  var rg = null;
  if (e.g) {
    rg = REGIONS[e.g];
    if (!rg) {
      return {
        statusCode: 503,
        statusDescription: 'Service Unavailable',
        headers: { 'cache-control': { value: 'no-store' }, 'retry-after': { value: '300' } }
      };
    }
  }
`,
    staticAssets: `    if (rg) toBucket(rg.b);
`,
    bucketExpr: `rg ? rg.b : ${home}`,
    dynamic: `  if (rg) cf.updateRequestOrigin({ "domainName": rg.h });
`,
  };
}
