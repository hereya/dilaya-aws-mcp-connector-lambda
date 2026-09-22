const crypto = require("crypto");
const https = require("https");

let cachedJwks = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// JWKS lives at the issuer's ORIGIN root, not under its path. Both the legacy
// per-org AS (issuer `https://dilaya.eu`) and the single-URL connect AS (issuer
// `https://dilaya.eu/oauth/connect`) publish it at `<origin>/.well-known/jwks.json`
// and sign with the same KMS key — so deriving from the origin is correct for
// both and identical to the old string-concat when OAUTH_SERVER_URL has no path.
function jwksUrl() {
  return new URL("/.well-known/jwks.json", process.env.OAUTH_SERVER_URL).toString();
}

async function getJwks() {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) return cachedJwks;
  const jwks = await fetchJson(jwksUrl());
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token, jwk) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const signature = base64urlDecode(signatureB64);
  const isValid = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature
  );
  if (!isValid) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

/**
 * Pure claim authorization — the backward-compatible dual-mode gate. Signature
 * and exp are verified by the caller; this decides iss/org binding + context.
 *
 *   env.oauthServerUrl   the deploy's issuer (legacy: base; connector: base/oauth/connect)
 *   env.boundOrgId       set on legacy per-org deployments; empty on the connector
 *   env.expectedAudience optional RFC 8707 resource the token must be bound to
 *
 * Returns { isAuthorized, context } | { isAuthorized: false, reason }.
 */
function authorizeClaims(payload, env) {
  const deny = (reason) => ({ isAuthorized: false, reason });
  if (!payload || typeof payload !== "object") return deny("bad_payload");
  if (payload.iss !== env.oauthServerUrl) return deny("issuer_mismatch");

  const userId = String(payload.sub ?? "");
  const orgRole = String(payload.org_role ?? "");

  if (env.boundOrgId) {
    // Legacy per-org mode — byte-for-byte the historical behavior.
    if (payload.org_id !== env.boundOrgId) return deny("org_mismatch");
    return {
      isAuthorized: true,
      context: { userId, orgId: String(payload.org_id ?? ""), orgRole },
    };
  }

  // Multi-tenant connect mode — the token carries the org SET.
  const orgIds = Array.isArray(payload.org_ids)
    ? payload.org_ids.filter((o) => typeof o === "string" && o)
    : [];
  if (orgIds.length === 0) return deny("no_org_ids");
  // Optional audience binding (RFC 8707): if configured, the token's aud must
  // match this resource so a token minted for another resource can't be replayed.
  if (env.expectedAudience && payload.aud !== env.expectedAudience) return deny("audience_mismatch");

  return {
    isAuthorized: true,
    context: {
      userId,
      orgId: "", // no single bound org in multi-tenant mode
      orgIds: orgIds.join(","), // API GW context values must be strings
      orgRole,
    },
  };
}

exports.authorizeClaims = authorizeClaims;

// One JSON line per refusal (t_mcp_403_no_alarm). On 2026-09-21 /mcp answered 403
// to almost everyone for ~2 h and this function had written START/END/REPORT
// only: nothing said WHY. Never the token; `sub` / `clientId` only once the
// signature held — before that the payload is whatever the caller typed.
// NOT the count the alarm reads: refusals are cached 5 min by the gateway, so a
// retrying client is refused without ever reaching this code. The alarm counts
// the access log (Mcp403); this line explains it.
//
// `refusal` is the ONE word handed back to the gateway, for the access log only
// (t_mcp403_stale_retry_noise): a client cut off hours ago whose Claude retries
// every hour with the same dead token is `stale` — not a new breakage. Anything
// else is `fresh`, and only `fresh` rings. It rides the gateway's 5-min cache
// with the refusal, so cached refusals are sorted too. Never the reason itself.
const STALE_AFTER_SEC = 7200;
exports.STALE_AFTER_SEC = STALE_AFTER_SEC;

function refuse(event, reason, claims) {
  const line = { type: "mcp_authorizer_refused", reason, routeKey: event?.routeKey ?? null };
  const ua = event?.headers?.["user-agent"];
  if (typeof ua === "string") line.ua = ua.slice(0, 120);
  if (claims) {
    line.sub = String(claims.sub ?? "");
    if (claims.client_id !== undefined) line.clientId = String(claims.client_id);
    if (typeof claims.exp === "number") line.expiredForSec = Math.floor(Date.now() / 1000) - claims.exp;
  }
  const stale = reason === "expired" && line.expiredForSec >= STALE_AFTER_SEC;
  line.refusal = stale ? "stale" : "fresh";
  console.log(JSON.stringify(line));
  // An HTTP API Lambda authorizer cannot choose its status: a deny is a 403
  // with no WWW-Authenticate, and a client holding a dead token has nothing to
  // repair — one member replayed a token dead since the 21/09 incident every
  // 5 min for 18 h (t_expired_token_403_stuck). RFC 6750 wants a 401
  // invalid_token. So in multi-tenant mode the request is ALLOWED with the
  // refusal in its context and NO identity at all, and the connector Lambda
  // (>= 0.1.308, src/handler/refused-token.ts) answers the 401 at its door.
  // Fail-closed either way: no orgIds means no org can be resolved. The legacy
  // per-org mode keeps the historical deny.
  if (process.env.BOUND_ORG_ID) return { isAuthorized: false, context: { refusal: line.refusal } };
  return {
    isAuthorized: true,
    context: { refusal: line.refusal, refusalReason: reason, userId: "", orgId: "", orgIds: "", orgRole: "" },
  };
}

exports.handler = async function (event) {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader?.startsWith("Bearer ")) return refuse(event, "no_bearer");

  const token = authHeader.slice(7);
  let stage = "malformed";
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString());
    if (header.alg !== "RS256") return refuse(event, "bad_alg");

    stage = "jwks_unavailable";
    const jwks = await getJwks();
    const jwk = header.kid ? jwks.keys.find((k) => k.kid === header.kid) : jwks.keys[0];
    if (!jwk) return refuse(event, "unknown_kid");

    stage = "malformed";
    const payload = verifyRS256(token, jwk);
    if (!payload) return refuse(event, "bad_signature");

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return refuse(event, "expired", payload);

    const verdict = authorizeClaims(payload, {
      oauthServerUrl: process.env.OAUTH_SERVER_URL,
      boundOrgId: process.env.BOUND_ORG_ID,
      expectedAudience: process.env.EXPECTED_AUDIENCE,
    });
    return verdict.isAuthorized ? verdict : refuse(event, verdict.reason, payload);
  } catch {
    return refuse(event, stage);
  }
};
