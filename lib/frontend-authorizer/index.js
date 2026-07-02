const crypto = require("crypto");
const https = require("https");
const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require("@aws-sdk/client-rds-data");

// ---------------------------------------------------------------------------
// Multi-tenant frontend authorizer
//
// Each per-app Cognito pool issues its own tokens. We derive the app (schema)
// from the request path (`/{schema}/...`), look up the pool ID for that app in
// public._app_auth, and validate the JWT against that pool's JWKS. If no row
// exists for the schema, we fall back to the shared org pool (Phase-A
// migration — see /plans/i-need-to-add-serialized-mountain.md).
// ---------------------------------------------------------------------------

const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.clusterArn;
const SECRET_ARN = process.env.secretArn;
const DATABASE_NAME = process.env.databaseName;
const SHARED_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_REGION = process.env.COGNITO_REGION;

// JWKS cache, keyed by pool ID. TTL 1 hour.
const jwksCache = new Map();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

// Schema → pool ID lookup cache. TTL 60s so `enable-auth` takes effect fast.
const poolLookupCache = new Map();
const POOL_LOOKUP_TTL_MS = 60 * 1000;

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

async function getJwks(poolId) {
  const now = Date.now();
  const hit = jwksCache.get(poolId);
  if (hit && now - hit.at < JWKS_CACHE_TTL_MS) return hit.jwks;
  const jwks = await fetchJson(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${poolId}/.well-known/jwks.json`
  );
  jwksCache.set(poolId, { jwks, at: now });
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

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  });
  return cookies;
}

function extractSchema(rawPath) {
  const m = (rawPath || "").match(/^\/([a-z][a-z0-9_-]*)(?:\/|$)/i);
  return m ? m[1] : null;
}

async function lookupPoolId(schema) {
  if (!schema) return null;
  const now = Date.now();
  const hit = poolLookupCache.get(schema);
  if (hit && now - hit.at < POOL_LOOKUP_TTL_MS) return hit.poolId;

  if (!CLUSTER_ARN || !SECRET_ARN || !DATABASE_NAME) return null;

  try {
    const result = await rds.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        sql: `SELECT user_pool_id FROM public._app_auth WHERE schema_name = :schema`,
        parameters: [
          { name: "schema", value: { stringValue: schema } },
        ],
      })
    );
    const poolId = result.records?.[0]?.[0]?.stringValue ?? null;
    poolLookupCache.set(schema, { poolId, at: now });
    return poolId;
  } catch (err) {
    console.error("frontend-authorizer: _app_auth lookup failed:", err);
    return null;
  }
}

// Allow as public (no authenticated user). The org Lambda decides per
// endpoint whether public is acceptable via the `public: "true"` context
// marker.
const PUBLIC = {
  isAuthorized: true,
  context: { email: "", cognito_sub: "", public: "true" },
};

exports.handler = async function (event) {
  const cookieHeader = event.headers?.cookie ?? event.headers?.Cookie ?? "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies["hereya_id_token"];
  if (!token) return PUBLIC;

  // Decide which pool to validate against.
  const schema = extractSchema(event.rawPath);
  const appPoolId = await lookupPoolId(schema);
  const poolId = appPoolId || SHARED_POOL_ID;
  if (!poolId) return PUBLIC;

  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString());
    if (header.alg !== "RS256") return PUBLIC;

    const jwks = await getJwks(poolId);
    const jwk = header.kid
      ? jwks.keys.find((k) => k.kid === header.kid)
      : jwks.keys[0];
    if (!jwk) return PUBLIC;

    const payload = verifyRS256(token, jwk);
    if (!payload) return PUBLIC;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return PUBLIC;

    return {
      isAuthorized: true,
      context: {
        email: String(payload.email ?? ""),
        cognito_sub: String(payload.sub ?? ""),
        public: "false",
      },
    };
  } catch (err) {
    console.error("frontend-authorizer: verification failed:", err);
    return PUBLIC;
  }
};
