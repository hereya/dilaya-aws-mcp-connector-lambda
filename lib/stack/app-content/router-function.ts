import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { StackContext } from "../context";

export function createAppHostRouter(stack: cdk.Stack, ctx: StackContext): void {
  const { appHostKvs, appLambdaNamePrefix, domainName, staticAssetsBucket } = ctx;
        const appHostRouterFn = new cloudfront.Function(stack, "AppHostRouter", {
          functionName: `${appLambdaNamePrefix}apphost-router`,
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          keyValueStore: appHostKvs,
          code: cloudfront.FunctionCode.fromInline(`import cf from 'cloudfront';
const kvs = cf.kvs();
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
  //   x = 1  the ORGANIZATION IS PAUSED — trial over, payment missing, or an
  //          operator's decision (deploy-pkg >= 0.1.60, t_pause_stops_frontends)
  //   x = 2  the org is fine but PAST ITS MONTHLY REQUEST ALLOWANCE
  //          (deploy-pkg >= 0.1.61, t_quota_cut_at_edge)
  //
  // Answered HERE, at the edge, and that placement is the whole point: the
  // frontend authorizer never runs for a cache hit or for any path of a
  // static-mode site, so a gate placed there stops exactly the orgs whose sites
  // are CHEAPEST for us to keep serving and leaves the expensive ones online.
  // The monthly cap already had that shape — it cut in the authorizer, which a
  // fully static site never reaches — so it bit the wrong half of the tenants
  // until this branch. Before the redirect branch too: a stopped site does not
  // forward visitors either.
  //
  // TWO PAGES, because the two causes have different ways out and telling a
  // customer over their allowance that their subscription is paused would send
  // them to a payment page that has nothing to fix. NO APOSTROPHES in either
  // body: this string is a JS single-quoted literal generated from a TS
  // template literal, so a plain ' would terminate it and take every tenant
  // site down with a syntax error (2026-08-29). Typographic U+2019 only.
  //
  // 503, not 403: both are temporary — one ends when the org is reactivated,
  // the other at the start of next month — and 503 is the one status that says
  // "temporarily unavailable" to a search engine instead of "gone". A no-store
  // header so neither page survives the recovery.
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
        ? '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Plafond mensuel atteint</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#1c1917;background:#faf9f7}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 .5rem;color:#57534e}</style><main><h1>Ce site a atteint son plafond mensuel</h1><p>Son espace a consommé le trafic inclus dans son forfait pour ce mois-ci. Rien ne se perd : le site revient au début du mois prochain, ou dès que son propriétaire augmente son forfait.</p><p lang=en>This site has reached its monthly traffic allowance. Nothing is lost — it returns at the start of next month, or as soon as its owner raises their plan.</p></main>'
        : '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Site en pause</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#1c1917;background:#faf9f7}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 .5rem;color:#57534e}</style><main><h1>Ce site est momentanément en pause</h1><p>Son espace est suspendu. Rien ne se perd : le site revient dès que son propriétaire réactive son espace.</p><p lang=en>This site is paused. Nothing is lost — it returns as soon as its owner reactivates their space.</p></main>'
    };
  }
  // CANONICAL REDIRECT (value flag r = target host): the host 301s to the same
  // path+query on r instead of serving the app — rendered entirely at the edge
  // (no Lambda), identical in static and dynamic modes. Set via
  // set-custom-domain({ redirect_to }); the connector guarantees r is a host of
  // the same app and never itself a redirect (no chains).
  if (e.r) {
    var loc = 'https://' + e.r + request.uri;
    var qs = request.querystring;
    var parts = [];
    for (var k in qs) {
      if (qs[k].multiValue) {
        for (var j = 0; j < qs[k].multiValue.length; j++) parts.push(k + '=' + qs[k].multiValue[j].value);
      } else {
        parts.push(k + '=' + qs[k].value);
      }
    }
    if (parts.length) loc += '?' + parts.join('&');
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
        // (no key, or a pre-route connector) -> the SPA fallback below, byte-
        // identical to the historical behavior.
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
        "domainName": "${staticAssetsBucket.bucketRegionalDomainName}",
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
}`),
        });
  ctx.appHostRouterFn = appHostRouterFn;
}