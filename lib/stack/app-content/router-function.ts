import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { StackContext } from "../context";
import {
  CLOUDFRONT_FUNCTION_MAX_BYTES,
  STOP_PAGE_ALLOWANCE,
  STOP_PAGE_PAUSED,
  stripCommentLines,
} from "./router-stop-pages";
import { LOGIN_GATE_BRANCH } from "./router-login-gate";

/**
 * The viewer-request function's SOURCE, comments included — read this, ship
 * `routerFunctionCode()`. Every `//` line below is stripped before synth (the
 * edge has a 10 KB code budget); the code lines ship byte-identical.
 */
export function routerFunctionSource(staticBucketDomain: string): string {
  return `import cf from 'cloudfront';
const kvs = cf.kvs();
function qsOf(request) {
  var qs = request.querystring;
  var parts = [];
  for (var k in qs) {
    if (qs[k].multiValue) {
      for (var j = 0; j < qs[k].multiValue.length; j++) parts.push(k + '=' + qs[k].multiValue[j].value);
    } else {
      parts.push(k + '=' + qs[k].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}
async function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var e;
  try {
    // NOTE: the JS 2.0 runtime rejects \`await\` inside a call ARGUMENT
    // ("await in arguments not supported") — hoist it (prod 503, 2026-07-19).
    var raw = await kvs.get(host);        // unknown host -> throws
    e = JSON.parse(raw);
  } catch (err) {
    return request;                       // passthrough -> origin 404
  }
  // SITE STOPPED (value flag x). Two causes, one mechanism:
  //   x = 1  the ORGANIZATION IS PAUSED (deploy-pkg >= 0.1.60, t_pause_stops_frontends)
  //   x = 2  the org is PAST ITS MONTHLY REQUEST ALLOWANCE (deploy-pkg >= 0.1.61)
  // Answered HERE, at the edge: the frontend authorizer never runs for a cache
  // hit or for any path of a static-mode site, so a gate placed there stops
  // exactly the orgs whose sites are CHEAPEST to keep serving. Before the
  // redirect branch too: a stopped site does not forward visitors either.
  // 503, not 403: both causes are temporary, and 503 tells a search engine
  // "temporarily unavailable" instead of "gone". Pages in router-stop-pages.ts.
  if (e.x) {
    return {
      statusCode: 503,
      statusDescription: 'Service Unavailable',
      headers: {
        'content-type': { value: 'text/html; charset=utf-8' },
        'cache-control': { value: 'no-store' },
        'retry-after': { value: '3600' }
      },
      body: e.x === 2
        ? '${STOP_PAGE_ALLOWANCE}'
        : '${STOP_PAGE_PAUSED}'
    };
  }
  // CANONICAL REDIRECT (value flag r = target host): the host 301s to the same
  // path+query on r instead of serving the app — rendered entirely at the edge
  // (no Lambda), identical in static and dynamic modes. Set via
  // set-custom-domain({ redirect_to }); the connector guarantees r is a host of
  // the same app and never itself a redirect (no chains).
  if (e.r) {
    var loc = 'https://' + e.r + request.uri;
    loc += qsOf(request);
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        'location': { value: loc },
        'cache-control': { value: 'public, max-age=3600' }
      }
    };
  }
  var uri = request.uri;                  // e.g. "/e/foo" or "/auth/login" or "/"
  // LOGIN REQUIRED (value flags auth + pub) — the branch lives in router-login-gate.ts.
${LOGIN_GATE_BRANCH}
  // STAGING (value flag e = 's', deploy-pkg >= 0.1.30): this host serves the
  // app's staging deployment — same app, same data, candidate CODE. Its S3
  // folders carry a '--stg' suffix (app names never contain '-', so no
  // collision) and its dynamic origin routes to /site-stg. /auth/* stays
  // SHARED with production (auth is app-level; one login works on both hosts).
  var a = e.a;
  var siteSeg = '/site';
  if (e.e === 's') { a = e.a + '--stg'; siteSeg = '/site-stg'; }
  // /static/* is served straight from the static-assets S3 origin (the
  // "/static/*" cache behavior matches on the VIEWER uri, then this rewrite
  // maps it to the tenant's key prefix): "/static/x" -> "/_appstatic/<org>/<app>/x"
  if (uri === '/static' || uri.indexOf('/static/') === 0) {
    request.uri = '/_appstatic/' + e.o + '/' + a + uri.slice(7);
    return request;
  }
  // STATIC sections (value flag p = URI prefix list, phase 3 hybrid): paths
  // under a declared prefix serve the app's pre-built site bundle from the
  // static bucket (/_appsite/<org>/<app>/..., OAC-signed origin swap, SPA
  // fallback to the SECTION's index.html). Everything else — ALWAYS including
  // /api/* and /auth/* — stays dynamic on the API-GW origin, so a hybrid app
  // keeps its Lambda pages and its login flow. p:["/"] = whole-site static.
  if (e.p && e.p.length && uri !== '/api' && uri.indexOf('/api/') !== 0
      && uri !== '/auth' && uri.indexOf('/auth/') !== 0) {
    var m = null;
    for (var i = 0; i < e.p.length; i++) {
      var pf = e.p[i];
      if (pf === '/' || uri === pf || uri.indexOf(pf + '/') === 0) {
        if (m === null || pf.length > m.length) m = pf;   // longest prefix wins
      }
    }
    if (m !== null) {
      var last = uri.split('/').pop();
      var file;
      if (last.indexOf('.') >= 0) {
        file = uri;                                       // real file — exact key
      } else {
        // FILE-FIRST resolution (deploy-pkg >= 0.1.34): a multi-page bundle
        // (Astro/Hugo/Next export) has site/<path>/index.html per page. The
        // connector writes one KVS route key per such page at deploy time
        // ('r|<org>|<folder>|<path>' -> '1', folder = app or app--stg), so the
        // edge can serve the PAGE's index.html instead of the section's. Miss
        // (no key, or a pre-route connector) -> the SPA fallback below.
        file = (m === '/' ? '' : m) + '/index.html';      // SPA fallback (section index)
        var norm = uri.length > 1 && uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
        if (norm !== '/' && norm !== m) {
          try {
            // JS 2.0: await must be a plain statement (never in an argument).
            var hit = await kvs.get('r|' + e.o + '|' + a + '|' + norm);
            if (hit) file = norm + '/index.html';
          } catch (miss) {
            // no such route -> keep the section fallback
          }
        }
      }
      request.uri = '/_appsite/' + e.o + '/' + a + file;
      cf.updateRequestOrigin({
        "domainName": "${staticBucketDomain}",
        "originAccessControlConfig": {
          "enabled": true,
          "signingBehavior": "always",
          "signingProtocol": "sigv4",
          "originType": "s3"
        },
        // Reset the API-GW origin's custom headers (x-dilaya-origin-verify):
        // unspecified settings are INHERITED from the assigned origin, and
        // S3+OAC must see none of them.
        "customHeaders": {}
      });
      return request;
    }
  }
  // auth routes live at /o/<org>/<app>/auth/... ; everything else at
  // /o/<org>/<app>/site/... (production) or .../site-stg/... (staging).
  var prefix = uri === '/auth' || uri.indexOf('/auth/') === 0
      ? '/o/' + e.o + '/' + e.a
      : '/o/' + e.o + '/' + e.a + siteSeg;
  request.uri = prefix + uri;             // "/o/<org>/<app>/site/e/foo"
  request.headers['x-dilaya-app-host'] = { value: host };  // carry viewer host to origin
  return request;
}`;
}

/** What actually ships: the source minus its comment lines. */
export function routerFunctionCode(staticBucketDomain: string): string {
  return stripCommentLines(routerFunctionSource(staticBucketDomain));
}

export function createAppHostRouter(stack: cdk.Stack, ctx: StackContext): void {
  const { appHostKvs, appLambdaNamePrefix, staticAssetsBucket } = ctx;
  const code = routerFunctionCode(staticAssetsBucket.bucketRegionalDomainName);
  // The bucket domain is a CFN token here (resolved at deploy), so the byte
  // count below is a lower bound; the test suite measures the real thing with
  // a literal domain. Both must stay under the edge's 10 KB limit.
  if (Buffer.byteLength(code, "utf8") > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error("apphost router function exceeds the CloudFront 10 KB code limit");
  }
  const appHostRouterFn = new cloudfront.Function(stack, "AppHostRouter", {
    functionName: `${appLambdaNamePrefix}apphost-router`,
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    keyValueStore: appHostKvs,
    code: cloudfront.FunctionCode.fromInline(code),
  });
  ctx.appHostRouterFn = appHostRouterFn;
}
