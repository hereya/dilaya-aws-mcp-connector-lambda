import { stripCommentLines } from "../app-content/router-stop-pages";
import { ORG_REGIONS_HEADER, ROUTE_HEADER, VIEWER_HOST_HEADER } from "./config";

/** At most this many orgs of one token are looked up (one KVS read each). */
export const MAX_TOKEN_ORGS = 16;

/**
 * The viewer-request CloudFront Function's SOURCE, comments included — `viewerFunctionCode()`
 * is what ships (comment lines stripped). Runtime cloudfront-js-2.0, KVS = org id → region.
 *
 * It decides the ORIGIN, nothing else: no request is refused here, and the bearer is decoded
 * without any signature check because routing is all it buys — a forged token reaches a pod whose
 * authorizer refuses it, and a pod only serves its own region's orgs (t_rca_p0_ensureorg).
 *
 * x-dilaya-route tells the origin (and the Lambda@Edge) what was decided:
 *   path   /o/<orgId>/… — the org named in the path
 *   token  every org of the bearer lives in ONE region
 *   body   orgs in several regions: x-dilaya-org-regions lists the non-home ones
 *          ("<org>:<region>,…") and the Lambda@Edge reads the JSON-RPC body
 *   home   nothing to route on (no bearer, garbage, unknown orgs)
 */
export function viewerFunctionSource(origins: Record<string, string>, home: string): string {
  return `import cf from 'cloudfront';
const kvs = cf.kvs();
var ORIGINS = ${JSON.stringify(origins)};
var HOME = ${JSON.stringify(home)};
var MAX_ORGS = ${MAX_TOKEN_ORGS};
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
var ORG_RE = /^[A-Za-z0-9-]{1,64}$/;
// base64url -> binary string. Hand-written: it is the same code in the edge
// runtime and in the test harness, and depends on no runtime built-in.
function b64url(s) {
  var out = '', buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64.indexOf(s.charAt(i));
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 255);
      buf = buf & ((1 << bits) - 1);
    }
  }
  return out;
}
// The org ids a bearer CLAIMS (org_ids, or a legacy single orgId). Unverified.
function orgsOf(h) {
  var a = h.authorization;
  if (!a || !a.value || a.value.length > 16384) return [];
  var m = /^Bearer\\s+[A-Za-z0-9_-]+\\.([A-Za-z0-9_-]+)\\.[A-Za-z0-9_-]*$/.exec(a.value);
  if (!m) return [];
  var p;
  try { p = JSON.parse(b64url(m[1])); } catch (e) { return []; }
  if (!p || typeof p !== 'object') return [];
  var ids = Array.isArray(p.org_ids) ? p.org_ids : (typeof p.orgId === 'string' ? [p.orgId] : []);
  var out = [];
  for (var i = 0; i < ids.length && out.length < MAX_ORGS; i++) {
    if (typeof ids[i] === 'string' && ORG_RE.test(ids[i]) && out.indexOf(ids[i]) < 0) out.push(ids[i]);
  }
  return out;
}
// Unknown org (no KVS key) or a region this distribution has no origin for -> HOME.
async function regionOf(org) {
  var r;
  try { r = await kvs.get(org); } catch (e) { return HOME; }
  return ORIGINS[r] ? r : HOME;
}
async function handler(event) {
  var request = event.request;
  var h = request.headers;
  delete h['${ORG_REGIONS_HEADER}'];
  h['${VIEWER_HOST_HEADER}'] = { value: h.host ? h.host.value.toLowerCase() : '' };
  var route = 'home';
  var region = HOME;
  var pm = /^\\/o\\/([A-Za-z0-9-]{1,64})\\//.exec(request.uri);
  if (pm) {
    route = 'path';
    region = await regionOf(pm[1]);
  } else {
    var orgs = orgsOf(h);
    var seen = {};
    var n = 0;
    var away = [];
    for (var i = 0; i < orgs.length; i++) {
      var r = await regionOf(orgs[i]);
      if (!seen[r]) { seen[r] = 1; n++; region = r; }
      if (r !== HOME) away.push(orgs[i] + ':' + r);
    }
    if (n === 1) route = 'token';
    if (n > 1) {
      route = 'body';
      region = HOME;
      h['${ORG_REGIONS_HEADER}'] = { value: away.join(',') };
    }
  }
  h['${ROUTE_HEADER}'] = { value: route };
  // Only domainName: every other origin setting (the x-dilaya-region-verify
  // custom header above all) is inherited from the distribution's origin.
  if (region !== HOME) cf.updateRequestOrigin({ domainName: ORIGINS[region] });
  return request;
}`;
}

/** What actually ships: the source minus its comment lines. */
export function viewerFunctionCode(origins: Record<string, string>, home: string): string {
  return stripCommentLines(viewerFunctionSource(origins, home));
}
