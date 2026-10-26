import { stripCommentLines } from "../app-content/router-stop-pages";
import { ORG_REGIONS_HEADER, ROUTE_HEADER } from "./config";

/**
 * Largest body the handler will parse. CloudFront hands an origin-request Lambda@Edge at most a
 * bounded prefix of the body (`inputTruncated` beyond it); a truncated or larger body is NOT
 * parsed and the request goes to the home region. The body itself is never modified, so the
 * origin always receives it whole.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The origin-request Lambda@Edge's SOURCE, comments included — `edgeHandlerCode()` ships. Lambda@Edge
 * has no environment variables, so the origins are baked in at synth.
 *
 * It acts ONLY on what the viewer function marked `x-dilaya-route: body` (a bearer whose orgs sit in
 * different regions) and returns every other request untouched. It reads `params.arguments.org`
 * from the JSON-RPC message (a batch must agree on one org) and routes there when that org is one
 * of the bearer's non-home orgs listed in x-dilaya-org-regions. Anything else — no org (initialize,
 * tools/list), an org the header does not list, a body too big, unparseable JSON, any throw — goes
 * to the HOME region, which is where the request already points. Like the viewer function it only
 * picks an origin: the pod's authorizer and its own-region check still decide.
 */
export function edgeHandlerSource(origins: Record<string, string>, home: string): string {
  return `'use strict';
var ORIGINS = ${JSON.stringify(origins)};
var HOME = ${JSON.stringify(home)};
var MAX_BODY = ${MAX_BODY_BYTES};
function hv(h, k) { var v = h[k]; return v && v[0] ? String(v[0].value) : ''; }
function orgOf(msg) {
  var a = msg && msg.params && msg.params.arguments;
  return a && typeof a.org === 'string' ? a.org : '';
}
function bodyOrg(body) {
  if (!body || body.inputTruncated || typeof body.data !== 'string' || !body.data) return '';
  // Bounded BEFORE decoding: base64 is 4/3 of the bytes it carries.
  if (body.data.length > Math.ceil(MAX_BODY / 3) * 4) return '';
  var text = body.encoding === 'base64' ? Buffer.from(body.data, 'base64').toString('utf8') : body.data;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return '';
  var msg = JSON.parse(text);
  if (!Array.isArray(msg)) return orgOf(msg);
  var org = '';
  for (var i = 0; i < msg.length; i++) {
    var o = orgOf(msg[i]);
    if (!o) continue;
    if (org && o !== org) return '';
    org = o;
  }
  return org;
}
exports.handler = async function (event) {
  var request = event.Records[0].cf.request;
  var h = request.headers;
  if (hv(h, '${ROUTE_HEADER}') !== 'body') return request;
  var region = HOME;
  try {
    var org = bodyOrg(request.body);
    var pairs = org ? hv(h, '${ORG_REGIONS_HEADER}').split(',') : [];
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split(':');
      if (kv[0] === org && ORIGINS[kv[1]]) region = kv[1];
    }
  } catch (e) {
    region = HOME;
  }
  h['${ROUTE_HEADER}'] = [{ key: '${ROUTE_HEADER}', value: 'body-' + region }];
  if (region !== HOME && request.origin && request.origin.custom) {
    // The custom origin keeps its customHeaders (x-dilaya-region-verify); API
    // Gateway maps on Host, so Host follows the origin.
    request.origin.custom.domainName = ORIGINS[region];
    h.host = [{ key: 'Host', value: ORIGINS[region] }];
  }
  return request;
};
`;
}

/** What actually ships (inline ZipFile: CloudFormation caps it at 4 096 characters). */
export function edgeHandlerCode(origins: Record<string, string>, home: string): string {
  return stripCommentLines(edgeHandlerSource(origins, home));
}
