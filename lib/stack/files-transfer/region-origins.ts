/**
 * File links of ANOTHER region's pod on the SAME files host (`filesRegionOrigins`).
 *
 * The files distribution fronts ONE bucket (the pod's own) and proxies `/_t` to ONE connector
 * (the pod's own). A secondary pod signs for its own bucket and keeps its transfer rows in its
 * own table, so three things would fail for it behind this host: a presigned URL (wrong bucket),
 * the transfer page's form POST (to `/`, which carries no key) and the page's `/_t` lookup.
 *
 * With the parameter, the PRIMARY pod's distribution gains three behaviors per listed region —
 * nothing on the default behavior, no function on the byte path but a constant URI rewrite:
 *   /<prefix>/*     -> that region's bucket. Every object key starts with its pod's storage
 *                      prefix and the prefixes differ, so the path alone picks the bucket the
 *                      signature was made for (presigned GET/PUT, the page's download link);
 *   /_u/<region>    -> the same bucket, URI rewritten to "/" (the page's presigned form POST);
 *   /_t/<region>    -> that pod's own API host, URI rewritten to "/_t" (the page's lookup).
 *
 *   filesRegionOrigins  "<region>:<pod origin host>:<bucket>.s3.<region>.amazonaws.com:<storage prefix>"
 *                       comma-separated (":" because hereya cuts a -p at every "=")
 *
 * Absent parameter -> none of this is emitted and the template, page included, is byte-identical.
 */
export interface FilesRegionOrigin {
  region: string;
  /** The pod's own API host (its originDomain). */
  host: string;
  /** The region's file bucket, regional domain name — the host its pod presigns for. */
  bucketDomain: string;
  /** The pod's storage key prefix (its `s3Prefix`): the first path segment of every key. */
  prefix: string;
}

export const PARAM = "filesRegionOrigins";
/** 2 fixed behaviors + 3 per region must stay under CloudFront's default 25 per distribution. */
export const MAX_REGIONS = 6;

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BUCKET_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.([a-z]{2}(-[a-z]+)+-\d)\.amazonaws\.com$/;
// One path segment, starting with a letter or digit: it can therefore never be `_t`, `_u` or
// `_transfer…`, and it holds no CloudFront wildcard (`*`, `?`) and no `/`.
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

export const regionMaterialPath = (region: string) => `/_t/${region}`;
export const regionUploadPath = (region: string) => `/_u/${region}`;
export const regionKeyPattern = (prefix: string) => `/${prefix}/*`;

/** What the parameter is checked against: the pod reading it. */
export interface HomePod {
  region: string | undefined;
  /** The pod's own storage prefix; required, or no key could be told apart by its path. */
  prefix: string | undefined;
}

/** Parse + validate the parameter; an empty list when absent. Throws at synth on anything odd. */
export function parseFilesRegionOrigins(raw: string | undefined, home: HomePod): FilesRegionOrigin[] {
  if (!raw) return [];
  const fail = (m: string): never => {
    throw new Error(`${PARAM}: ${m}`);
  };
  if (!home.prefix) {
    fail("the pod's own storage prefix (s3Prefix in hereyaProjectEnv) is required, or its keys could match a region's path");
  }
  const out: FilesRegionOrigin[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [region, host, bucketDomain, prefix, ...rest] = entry.split(":");
    const bm = BUCKET_DOMAIN_RE.exec(bucketDomain ?? "");
    if (rest.length || !REGION_RE.test(region ?? "") || !HOST_RE.test(host ?? "") || !bm || !PREFIX_RE.test(prefix ?? "")) {
      fail(`"${entry}" is not <region>:<host>:<bucket>.s3.<region>.amazonaws.com:<storage prefix>`);
    }
    if (bm![1] !== region) fail(`bucket ${bucketDomain} is not in ${region}`);
    if (region === home.region) fail(`${region} is this pod's own region`);
    if (prefix === home.prefix) fail(`prefix ${prefix} is this pod's own storage prefix`);
    for (const o of out) {
      if (o.region === region) fail(`region ${region} listed twice`);
      if (o.host === host) fail(`host ${host} listed twice`);
      if (o.prefix === prefix) fail(`prefix ${prefix} listed twice`);
    }
    out.push({ region: region!, host: host!, bucketDomain: bucketDomain!, prefix: prefix! });
  }
  if (out.length === 0) fail("no origin given");
  if (out.length > MAX_REGIONS) fail(`at most ${MAX_REGIONS} regions (CloudFront behaviors per distribution)`);
  return out;
}

/**
 * The viewer-request rewrite of `/_u/<region>` and `/_t/<region>`: ONE assignment of a constant.
 * No branch, no loop, nothing read from the request — its cost cannot depend on the input (the
 * region router once passed its tests and exceeded the instruction limit on a real token).
 */
export function rewriteFunctionCode(target: "/" | "/_t"): string {
  return `function handler(event){var r=event.request;r.uri=${JSON.stringify(target)};return r;}`;
}
