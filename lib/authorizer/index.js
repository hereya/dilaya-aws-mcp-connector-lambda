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
 * Returns { isAuthorized, context } | { isAuthorized: false }.
 */
function authorizeClaims(payload, env) {
  const deny = { isAuthorized: false };
  if (!payload || typeof payload !== "object") return deny;
  if (payload.iss !== env.oauthServerUrl) return deny;

  const userId = String(payload.sub ?? "");
  const orgRole = String(payload.org_role ?? "");

  if (env.boundOrgId) {
    // Legacy per-org mode — byte-for-byte the historical behavior.
    if (payload.org_id !== env.boundOrgId) return deny;
    return {
      isAuthorized: true,
      context: { userId, orgId: String(payload.org_id ?? ""), orgRole },
    };
  }

  // Multi-tenant connect mode — the token carries the org SET.
  const orgIds = Array.isArray(payload.org_ids)
    ? payload.org_ids.filter((o) => typeof o === "string" && o)
    : [];
  if (orgIds.length === 0) return deny;
  // Optional audience binding (RFC 8707): if configured, the token's aud must
  // match this resource so a token minted for another resource can't be replayed.
  if (env.expectedAudience && payload.aud !== env.expectedAudience) return deny;

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

exports.handler = async function (event) {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader?.startsWith("Bearer ")) return { isAuthorized: false };

  const token = authHeader.slice(7);
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString());
    if (header.alg !== "RS256") return { isAuthorized: false };

    const jwks = await getJwks();
    const jwk = header.kid ? jwks.keys.find((k) => k.kid === header.kid) : jwks.keys[0];
    if (!jwk) return { isAuthorized: false };

    const payload = verifyRS256(token, jwk);
    if (!payload) return { isAuthorized: false };

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return { isAuthorized: false };

    return authorizeClaims(payload, {
      oauthServerUrl: process.env.OAUTH_SERVER_URL,
      boundOrgId: process.env.BOUND_ORG_ID,
      expectedAudience: process.env.EXPECTED_AUDIENCE,
    });
  } catch {
    return { isAuthorized: false };
  }
};
