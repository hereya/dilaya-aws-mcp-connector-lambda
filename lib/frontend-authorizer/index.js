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
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

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
const SITE_OR_AUTH_RE = /^\/o\/[^/]+\/[^/]+\/(?:site|auth)(?:\/|$)/;

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

/** Execute one read statement against the app's SQLite db (RDS-Data-compatible result). */
async function dataApiQuery(orgId, appId, sql, params) {
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

  const res = await fetch(url.toString(), { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`data API /query ${res.status}: ${text.slice(0, 200)}`);
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
      const ok = ORIGIN_VERIFY_SECRET
        ? h[ORIGIN_VERIFY_HEADER] === ORIGIN_VERIFY_SECRET ||
          (!!ORIGIN_VERIFY_SECRET_PREVIOUS &&
            h[ORIGIN_VERIFY_HEADER] === ORIGIN_VERIFY_SECRET_PREVIOUS)
        : !!h[EDGE_MARKER_HEADER];
      if (!ok) return { isAuthorized: false };
    }

    const parsed = extractOrgApp(rawPath);
    if (!parsed) return ANON;
    const { orgId, app } = parsed;

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
  }
};

// Exported for unit tests.
exports.__test__ = { extractOrgApp, verifySignedToken, mintCapability, b64url };
