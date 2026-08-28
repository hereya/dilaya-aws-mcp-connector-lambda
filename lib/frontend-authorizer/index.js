"use strict";
// ---------------------------------------------------------------------------
// Multi-tenant frontend authorizer (v2 / SQLite).
//
// Fronts the per-app web-frontend site routes (`ANY /o/{orgId}/{app}/site[...]`,
// AuthorizationType CUSTOM). It is a SINGLE authorizer shared by EVERY org/app;
// the org + app come from the request PATH, never a deploy-time binding.
//
// Per request it:
//   1. Parses orgId + app from `/o/{orgId}/{app}/...`.
//   2. Resolves the app UUID from the DynamoDB registry (name#<app> → appId,
//      then app#<appId> for status). Fails CLOSED (grants no identity) when the
//      app is missing or being deleted.
//   3. Reads the app's `_auth_config` row (user_pool_id / user_pool_client_id)
//      from the app's OWN SQLite db via the VM Data API (SigV4 `execute-api`,
//      `x-dilaya-capability` header the authorizer MINTS itself — it is trusted
//      deploy-package infra, not agent code).
//   4. Validates a Cognito ID-token cookie against that pool's JWKS (RS256), and
//      — when there is no Cognito session — the agent-session cookie
//      (`dilaya_agent`, HMAC via the per-app secret in APP_STATE_TABLE).
//
// It ALWAYS returns `isAuthorized: true` (mirroring the legacy authorizer): the
// per-app handler decides whether an anonymous request is acceptable or must be
// redirected to `/auth/login`. "Fail closed" here means: on ANY error or missing
// session we grant NO identity (empty email/cognito_sub) — never a forged one.
//
// AWS SDK v3 (runtime-provided) + node builtins only. SigV4 + capability signing
// + JWKS RS256 verification are implemented with `node:crypto`.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterHistoryCommand } = require("@aws-sdk/client-ssm");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

// --- Config ---------------------------------------------------------------

const AWS_REGION = process.env.awsRegion || process.env.AWS_REGION || "eu-west-1";
const COGNITO_REGION = process.env.COGNITO_REGION || AWS_REGION;
const DATA_API_URL = (process.env.dataApiUrl || "").replace(/\/+$/, "");
const REGISTRY_TABLE = process.env.registryTableName;
const APP_STATE_TABLE = process.env.APP_STATE_TABLE;
const CAP_SECRET_ARN =
  process.env.capabilitySecretArn || process.env.CAPABILITY_SECRET_ARN;
const CAP_SECRET_ENV = process.env.CAPABILITY_SECRET; // local/test escape hatch

// The ID-token cookie the auth Lambda sets after login. `hereya_id_token` is the
// legacy name — accepted so in-flight sessions survive a rename.
const ID_TOKEN_COOKIES = ["dilaya_id_token", "hereya_id_token"];
const AGENT_SESSION_COOKIE = "dilaya_agent";

// App-content ORIGIN LOCK. When vanity hosts are enabled (appContentDomain set),
// the per-app web frontend (site/auth routes) is reachable ONLY through the
// dilaya-apps.eu CloudFront edge, which stamps this marker header. A direct hit on
// the first-party app.dilaya.eu path URL lacks it and is denied. Empty → off.
const APP_CONTENT_DOMAIN =
  process.env.appContentDomain || process.env.APP_CONTENT_DOMAIN || "";
const EDGE_MARKER_HEADER = "x-dilaya-app-host";
// Covers production (/site), STAGING (/site-stg — the lazily-provisioned second
// environment, deploy-pkg >= 0.1.30) and the auth tree: all tenant-content
// paths, so none of them answers on the first-party path URL.
const SITE_OR_AUTH_RE = /^\/o\/[^/]+\/[^/]+\/(?:site(?:-stg)?|auth)(?:\/|$)/;

// Un-forgeable origin lock. Unlike the `x-dilaya-app-host` marker (whose presence
// a client can hand-forge), this is a SECRET the app-content CloudFront
// distribution stamps as `x-dilaya-origin-verify` on every edge->origin request.
// A direct hit on app.dilaya.eu can't reproduce it. When configured, the authorizer
// REQUIRES it on site/auth routes (secret-only — the legacy marker is no longer
// accepted). The prior transitional release accepted secret-OR-marker so the
// distribution's origin-header config could propagate to every edge with no 403
// window; that fallback is now removed.
const ORIGIN_VERIFY_HEADER = "x-dilaya-origin-verify";
const ORIGIN_VERIFY_SECRET =
  process.env.appContentOriginSecret ||
  process.env.APP_CONTENT_ORIGIN_SECRET ||
  "";
// Rotation window: while set, the PREVIOUS secret is ALSO accepted, so the new
// secret can roll out (CDK updates the shared distribution; the deploy-time
// trigger re-stamps the per-org BYOD distributions) with no 403 window while
// CloudFront propagates. Clear it on the deploy AFTER the rotation completes.
const ORIGIN_VERIFY_SECRET_PREVIOUS =
  process.env.appContentOriginSecretPrevious ||
  process.env.APP_CONTENT_ORIGIN_SECRET_PREVIOUS ||
  "";
// AUTO grace window (no manual "previous" needed): the deploy stores the
// current secret in a CFN-managed, VERSIONED SSM parameter. After a rotation,
// version N-1 is auto-accepted while the current version is younger than the
// grace window. Looked up LAZILY (only when a header does not match the
// current secret — zero SSM calls in steady state), cached, fail-closed.
// Emergency kill of a compromised old secret: rotate twice (it leaves N-1),
// or use the explicit PREVIOUS override above.
const ORIGIN_SECRET_PARAM = process.env.ORIGIN_SECRET_PARAM || "";
const ORIGIN_SECRET_GRACE_MS =
  (Number(process.env.ORIGIN_SECRET_GRACE_SECONDS) || 86400) * 1000;
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
let originPrevCache = { value: "", fetchedAt: 0 };
async function previousSecretInGrace() {
  if (!ORIGIN_SECRET_PARAM) return "";
  const now = Date.now();
  if (now - originPrevCache.fetchedAt < 5 * 60 * 1000) return originPrevCache.value;
  let value = "";
  try {
    // Walk the (short) history keeping the last two versions.
    let token;
    let last = null;
    let beforeLast = null;
    do {
      const res = await ssmClient.send(
        new GetParameterHistoryCommand({
          Name: ORIGIN_SECRET_PARAM,
          WithDecryption: true,
          NextToken: token,
        })
      );
      for (const p of res.Parameters || []) {
        beforeLast = last;
        last = p;
      }
      token = res.NextToken || undefined;
    } while (token);
    if (
      last &&
      beforeLast &&
      last.LastModifiedDate &&
      now - new Date(last.LastModifiedDate).getTime() < ORIGIN_SECRET_GRACE_MS
    ) {
      value = beforeLast.Value || "";
    }
  } catch (e) {
    // Fail CLOSED to strict single-secret mode.
    console.warn("origin-secret history lookup failed:", e && e.message);
  }
  originPrevCache = { value, fetchedAt: now };
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const secretsClient = new SecretsManagerClient({ region: AWS_REGION });

// --- base64url helpers ----------------------------------------------------

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// --- Capability minting (MUST match dilaya-connector/src/capability.ts) ----
// Format: v1.<b64url(JSON{o,a,e})>.<b64url(HMAC-SHA256(secret,"v1."+payload))>

let cachedCapSecret; // undefined = not loaded; null = none configured
async function getCapabilitySecret() {
  if (cachedCapSecret !== undefined) return cachedCapSecret;
  if (!CAP_SECRET_ARN) {
    cachedCapSecret = CAP_SECRET_ENV || null;
    return cachedCapSecret;
  }
  try {
    const r = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: CAP_SECRET_ARN })
    );
    cachedCapSecret = r.SecretString || null;
  } catch (err) {
    // Don't cache a transient failure — retry next call. Fail-open to "no
    // header"; the VM (warn mode) still accepts, and (enforce mode) denies.
    console.warn("frontend-authorizer: capability secret load failed:", err?.message || err);
    return null;
  }
  return cachedCapSecret;
}

async function mintCapability(orgId, appId, ttlSec = 300) {
  const secret = await getCapabilitySecret();
  if (!secret) return null;
  const payload = b64url(
    JSON.stringify({ o: orgId, a: appId, e: Math.floor(Date.now() / 1000) + ttlSec })
  );
  const signingInput = "v1." + payload;
  const sig = b64url(crypto.createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

// --- SigV4-signed Data API query ------------------------------------------

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

// States the Data API itself calls transient — the VM answers a bounce with
// 503 `UNAVAILABLE: instance is shutting down; retry shortly`. Mirrors
// dilaya-connector/src/dataapi-client.ts, whose client has always retried them
// (which is why the connector saw 0 errors through the 2026-07-29 bounce while
// these edge lambdas gave up on the first try and logged visitors out).
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DATA_API_RETRIES = 2; // extra attempts after the first
const DATA_API_RETRY_DELAY_MS = 150; // ×(attempt+1) → 150ms, then 300ms

/**
 * Execute one read statement against the app's SQLite db (RDS-Data-compatible
 * result), retrying a short, bounded number of times on a transient VM state or
 * a network blip. Non-retryable errors (4xx, bad SQL) throw on the first try.
 */
async function dataApiQuery(orgId, appId, sql, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dataApiQueryOnce(orgId, appId, sql, params);
    } catch (err) {
      if (!err || err.retryable !== true || attempt >= DATA_API_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, DATA_API_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

/** One signed attempt. Re-signed per attempt (pure crypto — no clock-skew edge). */
async function dataApiQueryOnce(orgId, appId, sql, params) {
  if (!DATA_API_URL) throw new Error("dataApiUrl env var is not set");
  const url = new URL(DATA_API_URL + "/query");
  const body = JSON.stringify({
    org_id: orgId,
    app_id: appId,
    sql,
    params: params || [],
    includeResultMetadata: true,
  });

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  const amzDate = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const cap = await mintCapability(orgId, appId);

  // Signed header set (lowercase names). `host` is signed but sent by fetch.
  // Includes x-amz-content-sha256 to match AWS's @smithy/signature-v4 (the signer
  // the connector uses) byte-for-byte.
  const signed = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) signed["x-amz-security-token"] = sessionToken;
  if (cap) signed["x-dilaya-capability"] = cap;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(signed[h]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "POST",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${AWS_REGION}/execute-api/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, AWS_REGION);
  const kService = hmac(kRegion, "execute-api");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Send everything we signed EXCEPT host (fetch/undici sets Host = url.host).
  const headers = {
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  if (cap) headers["x-dilaya-capability"] = cap;

  let res;
  try {
    res = await fetch(url.toString(), { method: "POST", headers, body });
  } catch (err) {
    // Network blip while the VM cycles — worth one more try.
    const e = new Error(`data API unreachable: ${err?.message || err}`);
    e.retryable = true;
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const e = new Error(`data API /query ${res.status}: ${text.slice(0, 200)}`);
    e.status = res.status;
    e.retryable = RETRYABLE_STATUS.has(res.status);
    throw e;
  }
  return res.json();
}

function fieldStr(field) {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  return null;
}

// --- Registry (DynamoDB) --------------------------------------------------

async function resolveAppId(orgId, app) {
  if (!REGISTRY_TABLE) return null;
  const alias = await ddb.send(
    new GetCommand({
      TableName: REGISTRY_TABLE,
      Key: { org_id: orgId, sk: `name#${app}` },
      ConsistentRead: true,
    })
  );
  const appId = alias.Item && alias.Item.appId;
  if (!appId) return null;
  // Fail closed on a deleting app row.
  const appRow = await ddb.send(
    new GetCommand({
      TableName: REGISTRY_TABLE,
      Key: { org_id: orgId, sk: `app#${appId}` },
      ConsistentRead: true,
    })
  );
  const status = appRow.Item && appRow.Item.status;
  if (!appRow.Item || status === "deleting") return null;
  return appId;
}

// --- _auth_config (SQLite, per app) --------------------------------------

const authConfigCache = new Map(); // key `${orgId}/${app}` → { at, value }
const AUTH_CFG_TTL_MS = 60 * 1000;

async function readAuthConfig(orgId, app) {
  const key = `${orgId}/${app}`;
  const hit = authConfigCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_CFG_TTL_MS) return hit.value;

  let value = null;
  try {
    const appId = await resolveAppId(orgId, app);
    if (appId) {
      const res = await dataApiQuery(
        orgId,
        appId,
        "SELECT user_pool_id, user_pool_client_id FROM _auth_config WHERE id = 1"
      );
      const rec = res.records && res.records[0];
      if (rec) {
        const poolId = fieldStr(rec[0]);
        const clientId = fieldStr(rec[1]);
        if (poolId) value = { appId, userPoolId: poolId, userPoolClientId: clientId };
      }
    }
  } catch (err) {
    // Table absent / VM unreachable → treat as "auth not resolvable" (anonymous),
    // never cache the failure so a transient blip self-heals.
    console.error("frontend-authorizer: _auth_config lookup failed:", err?.message || err);
    return null;
  }
  authConfigCache.set(key, { at: Date.now(), value });
  return value;
}

// --- JWKS + RS256 ---------------------------------------------------------

const jwksCache = new Map(); // poolId → { at, jwks }
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(poolId) {
  const hit = jwksCache.get(poolId);
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.jwks;
  const res = await fetch(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${poolId}/.well-known/jwks.json`
  );
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const jwks = await res.json();
  jwksCache.set(poolId, { at: Date.now(), jwks });
  return jwks;
}

function verifyRS256(token, jwk) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(signatureB64)
  );
  if (!ok) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

/** Validate a Cognito ID token against the app's pool. Returns {email, sub} or null. */
async function verifyCognitoIdToken(token, cfg) {
  try {
    const header = JSON.parse(base64urlDecode(token.split(".")[0]).toString());
    if (header.alg !== "RS256") return null;
    const jwks = await getJwks(cfg.userPoolId);
    const jwk = header.kid
      ? jwks.keys.find((k) => k.kid === header.kid)
      : jwks.keys[0];
    if (!jwk) return null;
    const payload = verifyRS256(token, jwk);
    if (!payload) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return null;
    const expectedIss = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${cfg.userPoolId}`;
    if (payload.iss !== expectedIss) return null;
    if (payload.token_use && payload.token_use !== "id") return null;
    // ID tokens carry aud = client id. Bind to the configured client when known.
    if (cfg.userPoolClientId && payload.aud && payload.aud !== cfg.userPoolClientId) {
      return null;
    }
    return { email: String(payload.email || ""), sub: String(payload.sub || "") };
  } catch (err) {
    console.error("frontend-authorizer: Cognito verify failed:", err?.message || err);
    return null;
  }
}

// --- Request counting (billing / consumption) ------------------------------
//
// One atomic increment per attributed request, into APP_STATE_TABLE — the same
// shape as the email counter (`mailcount#`) and the app-creation counter
// (`appcount#`) the connector already keeps. `get-usage-report` reads these and
// reports requests per app per month alongside database and storage bytes.
//
// It exists because, until now, an organization's consumption was measured in
// MEGABYTES, FILES and EMAILS and never in REQUESTS: nothing anywhere in the
// platform counted the one resource that has no ceiling. On 2026-08-27 a single
// looping browser produced ~70 % of a day's traffic and the report for that org
// would have looked entirely normal.
//
// Why the counting happens HERE. This authorizer runs on every tenant site/auth
// request, before any of them reaches the app, and it is the only component
// that sees that whole population. That also makes it the hottest path in the
// platform, so three deliberate constraints:
//
//   * ONE write, no read. `ADD` is atomic, so concurrent requests never lose a
//     count and nothing has to be read back to increment it.
//   * It NEVER changes the answer. The whole thing is wrapped so that a failed
//     or slow count cannot deny a request or turn an authorized one anonymous —
//     a counter is not worth breaking a working page over.
//   * It costs no added latency. The caller starts it as soon as the org and
//     app are known and only settles it on the way out, so it overlaps the
//     registry lookup, the Data API read and the JWKS work that follow.
//
// Keyed by app NAME rather than appId, deliberately: the name is in the path,
// so counting needs no extra lookup and — this is the part that matters —
// still counts apps whose auth is not enabled, where appId is never resolved.
// Those requests cost exactly as much as any other. The cost is that renaming
// an app starts a fresh count under the new name; `set-name` is a first-week
// operation and the old row simply ages out.
const requestCountPk = (orgId, app, month) => `reqcount#${orgId}#${app}#${month}`;

/** Count one request. Best-effort by construction — see above. */
async function bumpRequestCount(orgId, app) {
  if (!APP_STATE_TABLE) return;
  const month = new Date().toISOString().slice(0, 7);
  await ddb.send(
    new UpdateCommand({
      TableName: APP_STATE_TABLE,
      Key: { pk: requestCountPk(orgId, app, month) },
      UpdateExpression: "ADD #c :one SET expires_at = :e",
      ExpressionAttributeNames: { "#c": "requests" },
      ExpressionAttributeValues: {
        ":one": 1,
        // Thirteen months: enough that a year-on-year comparison still has the
        // row it needs, short enough that the table never becomes an archive.
        ":e": Math.floor(Date.now() / 1000) + 400 * 24 * 3600,
      },
    })
  );
}

// --- Per-IP rate guard (COUNT mode first) ---------------------------------
//
// The half of t_40535f5f467d that FREEZES rather than merely watches. It runs
// here, in the authorizer, and not in AWS WAF at the edge — a decision worth
// writing down, because the obvious argument points the other way.
//
// WAF cuts earlier, so it saves more per refused request: ~1.75 of the 2.7
// microdollars a tenant frontend request costs, against ~0.29 (11 %) for a
// refusal here, which still pays CloudFront, the gateway, this Lambda and the
// access log. On COST, WAF wins outright.
//
// But cost was the wrong axis: the 2026-08-27 loop — 17 386 requests, ~70 % of
// the day's traffic — cost FIVE CENTS. What it actually threatened is the
// SHARED RESOURCE: a loop hammering one tenant's backend hammers the SQLite
// Data API VM behind it, and that VM serves every other org. That is the same
// reasoning that justified the app-creation rate limit in the connector's
// quotas.ts — an availability problem for other tenants before it is a bill.
//
// On THAT axis the two are equal: both refuse before the backend Lambda, so
// both spare the VM. And this one costs no us-east-1 web ACL (a CLOUDFRONT
// -scope ACL cannot live in the stack's own region, and bin/*.ts defines a
// single stack), no ~$6/month, no new AWS surface — and it reuses the counter
// path already on this request. WAF becomes the right answer when volume makes
// those 1.75 microdollars matter, which is the world of the per-org traffic
// quota, not today's 68 298 requests a month.
//
// WINDOW, NOT RATE. The threshold is a count per rolling minute rather than a
// requests-per-second cap, because instantaneous rate does NOT separate the two
// populations — measured, not assumed:
//
//     busiest legitimate visitor-minute (3 days):   388 requests  (6.5/s)
//     busiest minute of the runaway loop:         1 155 requests (19.3/s)
//
// A 20/s cap would have let the loop through entirely; a 10/s cap sits 1.5x
// above real observed traffic and would eventually cut a real customer. What
// separates them is DURATION — a real visitor bursts and stops (388, then 270,
// then nothing), the loop held for 48 minutes. So: 1000 per minute per IP,
// 2.6x the worst real minute ever seen and comfortably under the loop.
//
// COUNT MODE IS THE DEFAULT, and that is not timidity. A per-IP limit is wrong
// about SHARED addresses — a corporate NAT, a mobile carrier gateway, a café.
// Nothing proves the IP behind that 388/minute was one person. So the guard
// first only reports what it WOULD have refused (`rate_guard` log line →
// metric filter → alarm); blocking is switched on later, from real data about
// who would actually have been cut, by setting FRONTEND_RATE_BLOCK=true.
const RATE_LIMIT_PER_MINUTE = Number(process.env.FRONTEND_RATE_LIMIT || 1000);
const RATE_BLOCK = String(process.env.FRONTEND_RATE_BLOCK || "") === "true";

/** The address the CDN itself saw. Behind CloudFront → API Gateway the chain
 *  ends `…, <viewer ip appended by CloudFront>, <cloudfront egress ip>`, so the
 *  SECOND-TO-LAST entry is the trustworthy one; the FIRST is whatever the
 *  client sent, and is forgeable — which would let an abuser dodge the guard by
 *  rotating a header. Same rule as the runtime layer's `req.clientIp`
 *  (src/runtime/request.ts clientIpFromChain); kept identical on purpose. */
function clientIpOf(event) {
  const h = event.headers || {};
  const xff = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  const clean = String(xff)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (clean.length >= 2) return clean[clean.length - 2];
  if (clean.length === 1) return clean[0];
  return event.requestContext?.http?.sourceIp || "";
}

/** Short, stable tag for an IP. The raw address never becomes a partition key:
 *  the rows outlive the request by a couple of minutes and there is no reason
 *  to keep a visitor's address around to count them. Same truncated-sha256
 *  shape the connector's usage counters use for user tags. */
function ipTag(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

const rateCountPk = (orgId, app, tag, minute) =>
  `ratecount#${orgId}#${app}#${tag}#${minute}`;

/**
 * Count this request against its (app, ip, minute) bucket and say whether the
 * bucket is over the limit.
 *
 * ATOMIC ADD reading its own result, deliberately not check-then-act: against
 * exactly the traffic this exists for — a burst arriving in parallel — a read
 * followed by a write lets the whole burst see the pre-burst count and pass
 * together. Each concurrent request gets a distinct number instead.
 *
 * Best-effort: any failure returns "not over", because a counter we cannot
 * write must never be the reason a working page is refused.
 */
async function checkRate(orgId, app, ip) {
  if (!APP_STATE_TABLE || !ip || !(RATE_LIMIT_PER_MINUTE > 0)) {
    return { over: false, count: 0 };
  }
  const minute = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: APP_STATE_TABLE,
        Key: { pk: rateCountPk(orgId, app, ipTag(ip), minute) },
        UpdateExpression: "ADD hits :one SET expires_at = :e",
        ExpressionAttributeValues: {
          ":one": 1,
          // The row's only job is to survive its own minute.
          ":e": Math.floor(Date.now() / 1000) + 300,
        },
        ReturnValues: "UPDATED_NEW",
      })
    );
    const count = Number(res.Attributes?.hits ?? 0);
    return { over: count > RATE_LIMIT_PER_MINUTE, count };
  } catch (err) {
    console.error("frontend-authorizer: rate check failed:", err?.message || err);
    return { over: false, count: 0 };
  }
}

// --- Agent-session cookie (HMAC, per-app secret in APP_STATE_TABLE) --------
// Matches dilaya-connector/src/token-signing.ts (signToken/verifyToken) +
// runtime/agent-auth.ts (SessionPayload). The per-app secret is
// ensureAppSecret() = the `appsecret#<orgId>#<app>` item's `secret` attribute.

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifySignedToken(secret, token) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let json;
  try {
    json = base64urlDecode(body).toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(crypto.createHmac("sha256", secret).update(json).digest());
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function getAppSecret(orgId, app) {
  if (!APP_STATE_TABLE) return null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: APP_STATE_TABLE,
        Key: { pk: `appsecret#${orgId}#${app}` },
      })
    );
    return (res.Item && res.Item.secret) || null;
  } catch (err) {
    console.error("frontend-authorizer: app secret lookup failed:", err?.message || err);
    return null;
  }
}

async function verifyAgentSession(cookie, orgId, app) {
  const secret = await getAppSecret(orgId, app);
  if (!secret) return null;
  const payload = verifySignedToken(secret, cookie);
  if (!payload) return null;
  if (payload.kind !== "agent-session" || payload.v !== 1) return null;
  if (payload.schema !== app) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return { email: String(payload.email || "") };
}

// --- Request parsing ------------------------------------------------------

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function collectCookies(event) {
  const cookies = {};
  // HTTP API v2 delivers cookies as an array; also honor a raw Cookie header.
  for (const c of event.cookies || []) {
    Object.assign(cookies, parseCookieHeader(c));
  }
  const h = event.headers || {};
  Object.assign(cookies, parseCookieHeader(h.cookie || h.Cookie));
  return cookies;
}

function extractOrgApp(rawPath) {
  const m = (rawPath || "").match(/^\/o\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  return { orgId: decodeURIComponent(m[1]), app: decodeURIComponent(m[2]) };
}

// Fail-closed identity: always allow the request through (the handler decides on
// anonymous), but grant NO authenticated identity.
const ANON = {
  isAuthorized: true,
  context: { email: "", cognito_sub: "", authenticated: "false", agent: "false", public: "true" },
};

exports.handler = async function (event) {
  // Settled in the `finally` below, never awaited inline — see bumpRequestCount.
  let counting = null;
  try {
    const rawPath = event.rawPath || event.requestContext?.http?.path || "";

    // App-content ORIGIN LOCK — deny direct first-party access to tenant frontends.
    // A site/auth request is served ONLY when it arrived via the dilaya-apps.eu
    // CloudFront edge (which stamps `x-dilaya-app-host`). A DIRECT hit on
    // app.dilaya.eu/o/<org>/<app>/{site,auth}/… lacks the marker → DENY (403), so
    // third-party org content never answers on the first-party domain. This is the
    // reputation firewall: Safe-Browsing / crawlers / indexers cannot send the
    // marker, so they can never fetch tenant content attributed to app.dilaya.eu.
    // (The public /agent, /telegram, /secrets routes are not fronted by this
    // authorizer, so they stay first-party-accessible.)
    if (APP_CONTENT_DOMAIN && SITE_OR_AUTH_RE.test(rawPath)) {
      const h = event.headers || {};
      // STRICT (un-forgeable): when the origin secret is configured, a site/auth
      // request MUST carry the matching `x-dilaya-origin-verify` — stamped only by
      // the app-content CloudFront distribution. A direct app.dilaya.eu hit can't
      // reproduce the secret, so it's denied (the legacy `x-dilaya-app-host` marker,
      // whose mere presence a client can forge, is no longer accepted). When NO
      // secret is configured we fall back to the marker-presence gate (feature-off
      // parity for deployments without appContentOriginSecret).
      let ok = ORIGIN_VERIFY_SECRET
        ? h[ORIGIN_VERIFY_HEADER] === ORIGIN_VERIFY_SECRET ||
          (!!ORIGIN_VERIFY_SECRET_PREVIOUS &&
            h[ORIGIN_VERIFY_HEADER] === ORIGIN_VERIFY_SECRET_PREVIOUS)
        : !!h[EDGE_MARKER_HEADER];
      if (!ok && ORIGIN_VERIFY_SECRET && h[ORIGIN_VERIFY_HEADER]) {
        // Rotation grace: a header that matches the PREVIOUS secret version is
        // accepted while the current version is younger than the grace window.
        const prev = await previousSecretInGrace();
        ok = !!prev && h[ORIGIN_VERIFY_HEADER] === prev;
      }
      if (!ok) return { isAuthorized: false };
    }

    const parsed = extractOrgApp(rawPath);
    if (!parsed) return ANON;
    const { orgId, app } = parsed;

    // Count it as soon as we know whose it is, and count it WHATEVER the answer
    // turns out to be: an anonymous request, or one the app then redirects to
    // login, consumed exactly the same Lambda invocation as an authorized one.
    // Started here rather than awaited, so the round-trip hides behind the
    // registry + Data API + JWKS work below.
    //
    // Requests refused by the origin lock above are deliberately NOT counted:
    // they are a direct hit on the first-party URL, i.e. a scanner or a crawler
    // rather than anything the organization did, and billing an org for someone
    // else's probing would be wrong.
    counting = bumpRequestCount(orgId, app);

    // Per-IP rate guard. In COUNT mode (the default) this only writes a line
    // saying what WOULD have been refused, so the guard can be calibrated on
    // real traffic before it is ever allowed to cut anyone — see checkRate.
    const ip = clientIpOf(event);
    const rate = await checkRate(orgId, app, ip);
    if (rate.over) {
      // One line per offending request, shaped as a stable metric-filter target
      // (`"type":"rate_guard"`). `blocked` is what actually happened, so the
      // same line reads correctly in both modes and the alarm that watches it
      // does not have to change when blocking is switched on.
      console.warn(
        JSON.stringify({
          type: "rate_guard",
          ts: new Date().toISOString(),
          org: orgId,
          app,
          ip: ipTag(ip),
          hits: rate.count,
          limit: RATE_LIMIT_PER_MINUTE,
          blocked: RATE_BLOCK,
          path: rawPath.slice(0, 200),
        })
      );
      if (RATE_BLOCK) return { isAuthorized: false };
    }

    const cfg = await readAuthConfig(orgId, app);
    if (!cfg) return ANON; // app missing/deleting or auth not enabled

    const cookies = collectCookies(event);

    // 1. Cognito ID token wins (a real human).
    let idToken = null;
    for (const name of ID_TOKEN_COOKIES) {
      if (cookies[name]) {
        idToken = cookies[name];
        break;
      }
    }
    if (idToken) {
      const id = await verifyCognitoIdToken(idToken, cfg);
      if (id) {
        return {
          isAuthorized: true,
          context: {
            email: id.email,
            cognito_sub: id.sub,
            authenticated: "true",
            agent: "false",
            public: "false",
          },
        };
      }
    }

    // 2. Agent-session cookie (browser testing of an authenticated app).
    const agentCookie = cookies[AGENT_SESSION_COOKIE];
    if (agentCookie) {
      const agent = await verifyAgentSession(agentCookie, orgId, app);
      if (agent) {
        return {
          isAuthorized: true,
          context: {
            email: agent.email,
            cognito_sub: "",
            authenticated: "true",
            agent: "true",
            public: "false",
          },
        };
      }
    }

    // 3. Anonymous — the per-app handler redirects to /auth/login if it must.
    return ANON;
  } catch (err) {
    console.error("frontend-authorizer: unexpected error:", err?.message || err);
    return ANON;
  } finally {
    // Settle the count without ever letting it speak. A Lambda that returns
    // while a promise is in flight has that promise frozen until the next
    // invocation, so it does have to be awaited — but a rejection here is
    // swallowed on purpose: an unwritable counter is a missing number, and a
    // missing number must never cost a working page its answer.
    if (counting) {
      try {
        await counting;
      } catch (err) {
        console.error(
          "frontend-authorizer: request count failed:",
          err?.message || err
        );
      }
    }
  }
};

// Exported for unit tests.
exports.__test__ = {
  extractOrgApp,
  verifySignedToken,
  mintCapability,
  b64url,
  SITE_OR_AUTH_RE,
  dataApiQuery,
  RETRYABLE_STATUS,
  DATA_API_RETRIES,
};
