"use strict";
// ---------------------------------------------------------------------------
// Multi-tenant auth Lambda (v2 / SQLite).
//
// Serves the passwordless email-OTP login flow for per-app web frontends — and,
// since t_auth_passkey, a WebAuthn PASSKEY sign-in on top of it (Cognito-native:
// USER_AUTH flow + WEB_AUTHN challenge; registration through Start/Complete-
// WebAuthnRegistration; nothing is stored or verified here). A SINGLE Lambda
// serves EVERY org/app; org + app come from the request PATH:
//   ANY /o/{orgId}/{app}/auth/{login|send-otp|verify|logout}
//   POST .../auth/passkey/{start|finish}            sign-in with a passkey
//   GET  .../auth/passkey/register                   post-OTP "set up a passkey?" offer
//   POST .../auth/passkey/register/{start|finish}    registration (AccessToken cookie)
//
// Per request it:
//   1. Parses orgId + app + action from the path.
//   2. Resolves the app UUID from the DynamoDB registry (fail closed if missing).
//   3. Reads the app's `_auth_config` (user_pool_client_id / from_email +
//      branding: custom_css / login_title / logo_url) and the
//      `_user_access` allowlist from the app's OWN SQLite db via the VM Data API
//      (SigV4 `execute-api` + an `x-dilaya-capability` header this Lambda MINTS
//      itself — trusted deploy-package infra, not agent code).
//   4. Reads the per-app Postmark server token from SSM SecureString at
//      /dilaya/<orgId>/apps/<app>/auth/postmark-server-token.
//   5. Drives Cognito CUSTOM_AUTH (per-app pool client) and emails the OTP via
//      Postmark; on success sets the `dilaya_id_token` cookie (Path-scoped to the
//      app) that the frontend authorizer validates.
//
// AWS SDK v3 (runtime-provided) + node builtins only.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const https = require("https");
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  StartWebAuthnRegistrationCommand,
  CompleteWebAuthnRegistrationCommand,
  AdminSetUserPasswordCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
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
const CAP_SECRET_ARN =
  process.env.capabilitySecretArn || process.env.CAPABILITY_SECRET_ARN;
const CAP_SECRET_ENV = process.env.CAPABILITY_SECRET;
const BUCKET_NAME = process.env.bucketName || process.env.BUCKET_NAME;
const S3_PREFIX = process.env.s3Prefix || process.env.S3_PREFIX;

const ID_TOKEN_COOKIE = "dilaya_id_token";
// Passkeys (t_auth_passkey). The fresh AccessToken rides this SHORT HttpOnly
// cookie between the OTP verify and the registration offer — never in HTML.
const ACCESS_TOKEN_COOKIE = "dilaya_at";
const ACCESS_TOKEN_MAX_AGE = 300;
// Remembered e-mail: a Cognito passkey sign-in needs the username BEFORE the
// challenge (no discoverable-credential path), so the login page pre-fills it.
// HttpOnly, host-bound, 90 days.
const LAST_EMAIL_COOKIE = "dilaya_last_email";
const LAST_EMAIL_MAX_AGE = 90 * 86400;
// Set once THIS device registered (or signed in with) a passkey: the post-OTP
// offer is then skipped, so a user who typed a code out of habit is not sent
// into a "credential already registered" dialog.
const PASSKEY_DONE_COOKIE = "dilaya_pk";
const PASSKEY_DONE_MAX_AGE = 365 * 86400;

const cognitoClient = new CognitoIdentityProviderClient({ region: COGNITO_REGION });
const s3Client = new S3Client({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

// ---------------------------------------------------------------------------
// i18n — English / French (unchanged from the legacy layer)
// ---------------------------------------------------------------------------

const i18n = {
  en: {
    loginTitle: "Sign in",
    loginSubtitle: "Enter your email to receive a one-time code.",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    continueButton: "Continue",
    otpTitle: "Check your email",
    otpSubtitle: (email) => `We sent a 6-digit code to <strong>${email}</strong>.`,
    otpLabel: "Verification code",
    verifyButton: "Verify",
    emailRequired: "Email is required.",
    noAccount: "No account found for this email. Contact the app owner to get access.",
    sendFailed: "Failed to send code. Please try again.",
    missingFields: "Missing required fields.",
    incorrectCode: "Incorrect code. Please try again.",
    expiredSession: "Incorrect code or session expired. Please try again.",
    authFailed: "Authentication failed.",
    emailSubject: "Your verification code",
    emailBody: (otp) => `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
    codeResent: "A new code has been sent to your email.",
    resendButton: "Resend code",
    backToEmail: "Use a different email",
    loadingContinue: "Sending...",
    loadingVerify: "Verifying...",
    loadingResend: "Sending...",
    passkeyButton: "Sign in with a passkey",
    passkeyFallback: "The passkey could not be used — we emailed you a code instead.",
    loadingPasskey: "Waiting for your device…",
    registerTitle: "Set up a passkey?",
    registerSubtitle:
      "Next time, sign in on this device with Touch ID, Face ID, Windows Hello or your security key — no email code.",
    registerYes: "Set up on this device",
    registerLater: "Not now",
    registerDone: "Passkey ready. Redirecting…",
    registerFailed:
      "The passkey could not be set up. You are signed in anyway — you can try again after your next email code.",
  },
  fr: {
    loginTitle: "Connexion",
    loginSubtitle: "Entrez votre email pour recevoir un code.",
    emailLabel: "Adresse email",
    emailPlaceholder: "vous@exemple.com",
    continueButton: "Continuer",
    otpTitle: "Consultez vos emails",
    otpSubtitle: (email) => `Nous avons envoyé un code à 6 chiffres à <strong>${email}</strong>.`,
    otpLabel: "Code de vérification",
    verifyButton: "Vérifier",
    emailRequired: "L’adresse email est requise.",
    noAccount: "Aucun compte trouvé pour cet email. Contactez le propriétaire de l’application.",
    sendFailed: "Échec de l’envoi du code. Veuillez réessayer.",
    missingFields: "Champs requis manquants.",
    incorrectCode: "Code incorrect. Veuillez réessayer.",
    expiredSession: "Code incorrect ou session expirée. Veuillez réessayer.",
    authFailed: "Échec de l’authentification.",
    emailSubject: "Votre code de vérification",
    emailBody: (otp) => `<p>Votre code de vérification est : <strong>${otp}</strong></p><p>Ce code expire dans 5 minutes.</p>`,
    codeResent: "Un nouveau code a été envoyé à votre email.",
    resendButton: "Renvoyer le code",
    backToEmail: "Utiliser un autre email",
    loadingContinue: "Envoi…",
    loadingVerify: "Vérification…",
    loadingResend: "Envoi…",
    passkeyButton: "Se connecter avec une passkey",
    passkeyFallback: "La passkey n’a pas pu être utilisée — un code vous a été envoyé par email.",
    loadingPasskey: "En attente de votre appareil…",
    registerTitle: "Enregistrer une passkey ?",
    registerSubtitle:
      "La prochaine fois, connectez-vous sur cet appareil avec Touch ID, Face ID, Windows Hello ou votre clé de sécurité — sans code par email.",
    registerYes: "Enregistrer sur cet appareil",
    registerLater: "Plus tard",
    registerDone: "Passkey enregistrée. Redirection…",
    registerFailed:
      "La passkey n’a pas pu être enregistrée. Vous êtes tout de même connecté — vous pourrez réessayer après votre prochain code par email.",
  },
};

function detectLang(event) {
  const accept = event.headers?.["accept-language"] || event.headers?.["Accept-Language"] || "";
  return accept.toLowerCase().startsWith("fr") ? "fr" : "en";
}
function t(lang) {
  return i18n[lang] || i18n.en;
}

// --- base64url + capability minting (matches src/capability.ts) -----------

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

let cachedCapSecret;
async function getCapabilitySecret() {
  if (cachedCapSecret !== undefined) return cachedCapSecret;
  if (!CAP_SECRET_ARN) {
    cachedCapSecret = CAP_SECRET_ENV || null;
    return cachedCapSecret;
  }
  try {
    const r = await secretsClient.send(new GetSecretValueCommand({ SecretId: CAP_SECRET_ARN }));
    cachedCapSecret = r.SecretString || null;
  } catch (err) {
    console.warn("auth-lambda: capability secret load failed:", err?.message || err);
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
// these edge lambdas gave up on the first try — here, the login page itself
// stopped working for the length of the bounce).
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DATA_API_RETRIES = 2; // extra attempts after the first
const DATA_API_RETRY_DELAY_MS = 150; // ×(attempt+1) → 150ms, then 300ms

/**
 * Execute one statement against the app's SQLite db, retrying a short, bounded
 * number of times on a transient VM state or a network blip. Non-retryable
 * errors (4xx, bad SQL) throw on the first try.
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

  // Signed set includes x-amz-content-sha256 to match AWS's @smithy/signature-v4
  // (the signer the connector uses) byte-for-byte.
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
  const canonicalRequest = ["POST", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${AWS_REGION}/execute-api/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, AWS_REGION);
  const kService = hmac(kRegion, "execute-api");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

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

// One Data API field → JS value. Strings as before; INTEGER columns (the
// `passkeys` flag, connector ≥0.1.254) come back as longValue and must not
// collapse to null.
function fieldStr(field) {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  return null;
}

// First record → { column_name: string|null }, resolved through columnMetadata
// so the read survives column reordering AND older _auth_config tables that
// don't have the branding columns yet (absent column → absent key → null).
function rowByName(res) {
  const rec = res.records && res.records[0];
  if (!rec) return null;
  const cols = res.columnMetadata || [];
  const out = {};
  for (let i = 0; i < cols.length; i++) {
    const name = cols[i] && (cols[i].name || cols[i].label);
    if (name) out[name] = fieldStr(rec[i]);
  }
  return out;
}

// --- Registry (DynamoDB) --------------------------------------------------

async function resolveAppId(orgId, app) {
  if (!REGISTRY_TABLE) return null;
  const alias = await ddb.send(
    new GetCommand({ TableName: REGISTRY_TABLE, Key: { org_id: orgId, sk: `name#${app}` }, ConsistentRead: true })
  );
  const appId = alias.Item && alias.Item.appId;
  if (!appId) return null;
  const appRow = await ddb.send(
    new GetCommand({ TableName: REGISTRY_TABLE, Key: { org_id: orgId, sk: `app#${appId}` }, ConsistentRead: true })
  );
  if (!appRow.Item || appRow.Item.status === "deleting") return null;
  return appId;
}

// --- _auth_config + allowlist (SQLite, per app) ---------------------------

const appAuthCache = new Map(); // `${orgId}/${app}` → { at, value }
const APP_AUTH_TTL_MS = 60 * 1000;

async function resolveAppAuth(orgId, app) {
  const key = `${orgId}/${app}`;
  const hit = appAuthCache.get(key);
  if (hit && Date.now() - hit.at < APP_AUTH_TTL_MS) return hit.value;

  let value = null;
  try {
    const appId = await resolveAppId(orgId, app);
    if (appId) {
      // SELECT * + read-by-name: the branding columns (custom_css /
      // login_title / logo_url) only exist on rows written by connector
      // ≥0.1.103 — older tables simply yield null for them.
      const res = await dataApiQuery(orgId, appId, "SELECT * FROM _auth_config WHERE id = 1");
      const row = rowByName(res);
      if (row && row.user_pool_client_id) {
        value = {
          appId,
          poolId: row.user_pool_id || null,
          clientId: row.user_pool_client_id,
          fromEmail: row.from_email || null,
          branding: {
            customCss: row.custom_css || null,
            loginTitle: row.login_title || null,
            logoUrl: row.logo_url || null,
          },
          // Passkeys: both columns are written by enable-auth (connector
          // ≥0.1.254); a row that predates them (never re-run) → off. The rpId
          // is the app's PRINCIPAL host the connector chose — see
          // passkeyHostMatches for why only that host offers the button.
          passkeys: (row.passkeys === 1 || row.passkeys === "1" || row.passkeys === true) && !!row.passkey_rp_id,
          passkeyRpId: row.passkey_rp_id ? String(row.passkey_rp_id).toLowerCase() : null,
        };
      }
    }
  } catch (err) {
    console.error("auth-lambda: _auth_config lookup failed:", err?.message || err);
    return null; // don't cache a transient failure
  }
  appAuthCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Best-effort allowlist gate. Returns true when the email is in `_user_access`,
 * false when it is definitively absent, and null when the check could not run
 * (table missing / VM error) so the caller falls back to Cognito's own
 * AllowAdminCreateUserOnly enforcement.
 */
async function isAllowlisted(orgId, appId, email) {
  try {
    const res = await dataApiQuery(
      orgId,
      appId,
      "SELECT 1 FROM _user_access WHERE lower(email) = lower(:email)",
      [{ name: "email", value: { stringValue: email } }]
    );
    return !!(res.records && res.records.length > 0);
  } catch (err) {
    console.error("auth-lambda: _user_access lookup failed:", err?.message || err);
    return null;
  }
}

// --- Postmark per-app server token (SSM SecureString) ---------------------

async function getPostmarkToken(orgId, app) {
  try {
    const param = await ssmClient.send(
      new GetParameterCommand({
        Name: `/dilaya/${orgId}/apps/${app}/auth/postmark-server-token`,
        WithDecryption: true,
      })
    );
    return param.Parameter?.Value || null;
  } catch (err) {
    if (err?.name !== "ParameterNotFound") {
      console.error("auth-lambda: SSM GetParameter failed for", app, err?.message || err);
    }
    return null;
  }
}

function sendPostmarkEmail(to, subject, htmlBody, opts) {
  const serverKey = opts?.serverKey;
  if (!serverKey) {
    console.error("auth-lambda: no Postmark server token available");
    return Promise.resolve();
  }
  const payload = JSON.stringify({
    From: opts?.fromEmail || `noreply@${opts?.senderDomain || "dilaya.eu"}`,
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    MessageStream: "outbound",
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.postmarkapp.com",
        path: "/email",
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverKey,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// --- Per-app custom CSS (best-effort) -------------------------------------

const cssCache = {};
async function loadCustomCss(orgId, app) {
  const cacheKey = `${orgId}/${app}`;
  if (cacheKey in cssCache) return cssCache[cacheKey];
  if (!BUCKET_NAME) {
    cssCache[cacheKey] = null;
    return null;
  }
  // Org-scoped mirror of the connector's storage layout: <s3Prefix>/<orgId>/<app>/...
  const rel = `${orgId}/${app}/auth/custom.css`;
  const key = S3_PREFIX ? `${S3_PREFIX}/${rel}` : rel;
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    cssCache[cacheKey] = await result.Body.transformToString("utf-8");
  } catch {
    cssCache[cacheKey] = null;
  }
  return cssCache[cacheKey];
}

// Defense in depth: the connector refuses '</style' at write time, but the CSS
// is injected verbatim inside a <style> element on the SHARED connector origin
// — strip any close tag that slipped in (older writers, manual DB edits).
function sanitizeCss(css) {
  if (css == null) return null;
  return String(css).replace(/<\/style/gi, "");
}

/**
 * Per-app branding for the login/OTP pages. DB row first (_auth_config
 * branding columns, via the 60s resolveAppAuth cache); the historical
 * best-effort S3 `auth/custom.css` object stays as the CSS fallback when the
 * row has none. Always returns an object — pages render unbranded when auth
 * isn't provisioned.
 */
async function resolveBranding(orgId, app) {
  const appAuth = await resolveAppAuth(orgId, app);
  const b = (appAuth && appAuth.branding) || {};
  const customCss = b.customCss != null ? b.customCss : await loadCustomCss(orgId, app);
  return {
    customCss: sanitizeCss(customCss),
    loginTitle: b.loginTitle || null,
    logoUrl: b.logoUrl || null,
  };
}

// --- HTML templates (unchanged from legacy, brand-neutral) ----------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHARED_STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #111; }
    p { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    label { display: block; font-size: 0.85rem; font-weight: 500; color: #333; margin-bottom: 6px; }
    input[type=email], input[type=text] { width: 100%; padding: 10px 14px; border: 1px solid #ddd;
                         border-radius: 8px; font-size: 1rem; outline: none; }
    input[type=text] { font-size: 1.5rem; text-align: center; letter-spacing: 0.3em; }
    input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
    button { width: 100%; padding: 12px; background: #4f46e5; color: #fff; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 500; cursor: pointer; margin-top: 16px; }
    button:hover { background: #4338ca; }
    button:disabled { background: #9ca3af; cursor: not-allowed; }
    button.secondary { background: #fff; color: #4f46e5; border: 1px solid #4f46e5; margin-top: 8px; }
    button.secondary:hover { background: #f5f3ff; }
    button.secondary:disabled { background: #f3f4f6; color: #9ca3af; border-color: #d1d5db; }
    .error { color: #dc2626; font-size: 0.85rem; margin-bottom: 16px; }
    .notice { color: #059669; font-size: 0.85rem; margin-bottom: 16px; background: #ecfdf5; padding: 10px 12px; border-radius: 8px; }
    .back-link { display: block; text-align: center; margin-top: 16px; font-size: 0.85rem; color: #4f46e5; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .login-logo { display: block; max-height: 56px; max-width: 100%; margin: 0 auto 16px; }`;

const SUBMIT_SCRIPT = `
  <script>
  (function(){
    document.querySelectorAll('form').forEach(function(form){
      form.addEventListener('submit', function(e){
        if (form.dataset.submitting === '1') { e.preventDefault(); return; }
        form.dataset.submitting = '1';
        var btn = form.querySelector('button[type=submit]');
        if (btn) {
          var label = btn.getAttribute('data-loading-label');
          if (label) btn.textContent = label;
          btn.disabled = true;
        }
      });
    });
  })();
  </script>`;

// Browser-side WebAuthn plumbing shared by the login page (assertion) and the
// register offer (attestation): base64url <-> ArrayBuffer and a same-origin
// JSON POST. Written for the widest browser range on purpose — no reliance on
// PublicKeyCredential.parseRequestOptionsFromJSON / toJSON (Chrome ≥129 only).
const WEBAUTHN_HELPERS = `
    var b2a=function(s){s=String(s).replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;};
    var a2b=function(buf){var u=new Uint8Array(buf),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');};
    var post=function(url,data){return fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)}).then(function(r){return r.json();});};
    var ext=function(c){try{return c.getClientExtensionResults?c.getClientExtensionResults():{};}catch(e){return {};}};`;

// Login-page passkey leg. The button is rendered `hidden` and revealed only
// where WebAuthn exists; every failure (no passkey for this e-mail, cancelled
// dialog, Cognito error) FALLS BACK to the e-mail code by submitting the OTP
// form with `passkey_fallback` set — never a dead end.
function passkeyLoginScript(s) {
  return `
  <script>
  (function(){
    var btn=document.getElementById('passkey-btn');
    if(!btn||!window.PublicKeyCredential||!navigator.credentials)return;
    btn.hidden=false;
    var form=btn.closest('form');${WEBAUTHN_HELPERS}
    var fallback=function(reason){form.querySelector('input[name=passkey_fallback]').value=reason||'error';if(form.requestSubmit)form.requestSubmit();else form.submit();};
    btn.addEventListener('click',function(){
      var email=form.querySelector('input[name=email]');
      if(!email.value||!email.checkValidity()){email.reportValidity();return;}
      btn.disabled=true;btn.textContent=${JSON.stringify(s.loadingPasskey)};
      var ret=form.querySelector('input[name=return_url]').value;
      post("passkey/start",{email:email.value}).then(function(st){
        if(!st||!st.options){fallback(st&&st.fallback);return;}
        var o=st.options;
        var pk={challenge:b2a(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:o.userVerification,
                allowCredentials:(o.allowCredentials||[]).map(function(c){return {type:c.type,id:b2a(c.id),transports:c.transports};})};
        return navigator.credentials.get({publicKey:pk}).then(function(cred){
          var r=cred.response;
          var body={id:cred.id,rawId:a2b(cred.rawId),type:cred.type,clientExtensionResults:ext(cred),
                    response:{authenticatorData:a2b(r.authenticatorData),clientDataJSON:a2b(r.clientDataJSON),signature:a2b(r.signature),userHandle:r.userHandle?a2b(r.userHandle):undefined}};
          if(cred.authenticatorAttachment)body.authenticatorAttachment=cred.authenticatorAttachment;
          return post("passkey/finish",{session:st.session,email:email.value,credential:body,return_url:ret});
        }).then(function(f){if(f&&f.redirect){location.assign(f.redirect);}else{fallback('error');}});
      }).catch(function(){fallback('error');});
    });
  })();
  </script>`;
}

function loginPage(returnUrl, error, branding, lang, prefillEmail, passkey) {
  const s = t(lang || "en");
  const b = branding || {};
  const title = b.loginTitle ? escapeHtml(b.loginTitle) : s.loginTitle;
  const logo = b.logoUrl ? `<img class="login-logo" src="${escapeHtml(b.logoUrl)}" alt="">` : "";
  const passkeyButton = passkey
    ? `<input type="hidden" name="passkey_fallback" value="">
      <button type="button" id="passkey-btn" class="secondary" hidden>${s.passkeyButton}</button>`
    : "";
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${SHARED_STYLE}</style>
  ${b.customCss ? `<style>${b.customCss}</style>` : ""}
</head>
<body>
  <div class="card">
    ${logo}
    <h1>${title}</h1>
    <p>${s.loginSubtitle}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="send-otp">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <label for="email">${s.emailLabel}</label>
      <input type="email" id="email" name="email" required autofocus placeholder="${s.emailPlaceholder}" value="${escapeHtml(prefillEmail || "")}">
      <button type="submit" data-loading-label="${escapeHtml(s.loadingContinue)}">${s.continueButton}</button>
      ${passkeyButton}
    </form>
  </div>
  ${SUBMIT_SCRIPT}${passkey ? passkeyLoginScript(s) : ""}
</body>
</html>`;
}

// The post-OTP offer. `returnUrl` is ALREADY safe (safeReturnUrl) — it lands
// in an href. Its endpoints are RELATIVE to this page's own URL
// (…/auth/passkey/register → base …/auth/passkey/), hence "register/start",
// not "passkey/register/start" (which resolved to /auth/passkey/passkey/… and
// 404ed in prod on 2026-09-13, 0.1.68). Without WebAuthn the page skips itself; a device that already
// holds this passkey (InvalidStateError) counts as done.
function registerPage(returnUrl, branding, lang) {
  const s = t(lang || "en");
  const b = branding || {};
  const logo = b.logoUrl ? `<img class="login-logo" src="${escapeHtml(b.logoUrl)}" alt="">` : "";
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${b.loginTitle ? escapeHtml(b.loginTitle) : s.registerTitle}</title>
  <style>${SHARED_STYLE}</style>
  ${b.customCss ? `<style>${b.customCss}</style>` : ""}
</head>
<body>
  <div class="card">
    ${logo}
    <h1>${s.registerTitle}</h1>
    <p>${s.registerSubtitle}</p>
    <div class="error" id="pk-error" hidden>${s.registerFailed}</div>
    <div class="notice" id="pk-done" hidden>${s.registerDone}</div>
    <button type="button" id="pk-yes">${s.registerYes}</button>
    <a class="back-link" id="pk-later" href="${escapeHtml(returnUrl || "/")}">${s.registerLater}</a>
  </div>
  <script>
  (function(){
    var yes=document.getElementById('pk-yes'),later=document.getElementById('pk-later'),err=document.getElementById('pk-error'),done=document.getElementById('pk-done');
    var go=function(){location.replace(later.getAttribute('href'));};
    if(!window.PublicKeyCredential||!navigator.credentials){go();return;}${WEBAUTHN_HELPERS}
    var finish=function(){done.hidden=false;yes.hidden=true;setTimeout(go,900);};
    yes.addEventListener('click',function(){
      yes.disabled=true;yes.textContent=${JSON.stringify(s.loadingPasskey)};
      post("register/start",{}).then(function(st){
        if(!st||!st.options)throw new Error((st&&st.error)||'start');
        var o=st.options;
        var pk={rp:o.rp,user:{id:b2a(o.user.id),name:o.user.name,displayName:o.user.displayName},challenge:b2a(o.challenge),
                pubKeyCredParams:o.pubKeyCredParams,timeout:o.timeout,attestation:o.attestation||'none',authenticatorSelection:o.authenticatorSelection,
                excludeCredentials:(o.excludeCredentials||[]).map(function(c){return {type:c.type,id:b2a(c.id),transports:c.transports};})};
        return navigator.credentials.create({publicKey:pk});
      }).then(function(cred){
        var r=cred.response;
        var body={id:cred.id,rawId:a2b(cred.rawId),type:cred.type,clientExtensionResults:ext(cred),
                  response:{clientDataJSON:a2b(r.clientDataJSON),attestationObject:a2b(r.attestationObject),transports:r.getTransports?r.getTransports():[]}};
        if(cred.authenticatorAttachment)body.authenticatorAttachment=cred.authenticatorAttachment;
        return post("register/finish",{credential:body});
      }).then(function(f){
        if(!f||!f.ok)throw new Error((f&&f.error)||'finish');
        finish();
      }).catch(function(e){
        if(e&&e.name==='InvalidStateError'){finish();return;}
        err.hidden=false;yes.hidden=true;
      });
    });
  })();
  </script>
</body>
</html>`;
}

function otpPage(session, email, returnUrl, error, notice, branding, lang) {
  const s = t(lang || "en");
  const b = branding || {};
  const logo = b.logoUrl ? `<img class="login-logo" src="${escapeHtml(b.logoUrl)}" alt="">` : "";
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${b.loginTitle ? escapeHtml(b.loginTitle) : s.otpLabel}</title>
  <style>${SHARED_STYLE}</style>
  ${b.customCss ? `<style>${b.customCss}</style>` : ""}
</head>
<body>
  <div class="card">
    ${logo}
    <h1>${s.otpTitle}</h1>
    <p>${s.otpSubtitle(escapeHtml(email))}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    <form method="POST" action="verify">
      <input type="hidden" name="session" value="${escapeHtml(session)}">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <label for="otp">${s.otpLabel}</label>
      <input type="text" id="otp" name="otp" required autofocus maxlength="6" pattern="[0-9]{6}"
             inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
      <button type="submit" data-loading-label="${escapeHtml(s.loadingVerify)}">${s.verifyButton}</button>
    </form>
    <form method="POST" action="send-otp" style="margin-top: 12px;">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <input type="hidden" name="resend" value="1">
      <button type="submit" class="secondary" data-loading-label="${escapeHtml(s.loadingResend)}">${s.resendButton}</button>
    </form>
    <a class="back-link" href="login?return_url=${encodeURIComponent(returnUrl || "")}&email=${encodeURIComponent(email)}">${s.backToEmail}</a>
  </div>
  ${SUBMIT_SCRIPT}
</body>
</html>`;
}

// --- Request helpers ------------------------------------------------------

// Form-encoded (the HTML forms) or JSON (the passkey fetch calls) → object.
function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString()
    : event.body || "";
  const h = event.headers || {};
  const ct = String(h["content-type"] || h["Content-Type"] || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const v = JSON.parse(raw || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function htmlResponse(statusCode, html) {
  return { statusCode, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
}

function jsonResponse(statusCode, obj, cookies) {
  const res = {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
  if (cookies && cookies.length) res.cookies = cookies;
  return res;
}

// Parse `/o/{orgId}/{app}/auth/{action}` → { orgId, app, action }.
function parsePath(rawPath) {
  const m = (rawPath || "").match(/^\/o\/([^/]+)\/([^/]+)\/auth\/(.+)$/);
  if (!m) return null;
  return {
    orgId: decodeURIComponent(m[1]),
    app: decodeURIComponent(m[2]),
    action: m[3],
  };
}

// The app's public site prefix — the safe default redirect target after login.
function sitePrefix(orgId, app) {
  return `/o/${orgId}/${app}/site`;
}

// Vanity-host awareness (host-routing / FLAT scheme). When the app-content edge
// (CloudFront Function) serves this app at <app>--<orgslug>.<appContentDomain>,
// it tags the viewer host in `x-dilaya-app-host`. On that host the app is at the
// ROOT (the edge maps `/` -> site, `/auth/*` -> auth), so cookies are Path=/ +
// Domain=<host> and redirects are app-relative. Absent the header the request
// came via the path URL (/o/<org>/<app>/…) and behaviour is unchanged.
// Case-insensitive read + strict hostname validation (the value lands in a
// Set-Cookie Domain= and a Location: header, so reject anything unexpected).
function getAppHost(event) {
  const headers = event.headers || {};
  for (const key in headers) {
    if (key.toLowerCase() === "x-dilaya-app-host") {
      const raw = headers[key];
      if (!raw) return null;
      const host = String(raw).trim().toLowerCase();
      return /^[a-z0-9.-]+$/.test(host) ? host : null;
    }
  }
  return null;
}

// Only allow same-host redirect targets. Relative single-slash paths pass
// through unchanged. An ABSOLUTE http(s) URL whose host equals the host
// actually serving this request (vanity host / custom domain, from the edge's
// x-dilaya-app-host tag) is accepted and NORMALIZED to its relative
// path+query, so the 302 stays same-host — apps naturally send
// `window.location.origin + path`, and silently dropping those onto the home
// page broke cariacomenu's post-OTP return (t_b7d2e90a4c15). Anything else
// (other host, protocol-relative //, javascript:, malformed) falls back to
// the app root: on a vanity host that's `/`; on the path URL the app's /site
// prefix. The anti-open-redirect guarantee is unchanged — we never redirect
// off the calling host.
function safeReturnUrl(raw, orgId, app, appHost) {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (raw && appHost) {
    try {
      const url = new URL(raw);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.host.toLowerCase() === appHost &&
        !url.pathname.startsWith("//")
      ) {
        return url.pathname + url.search;
      }
    } catch {
      // malformed → fall through to the default
    }
  }
  return appHost ? "/" : sitePrefix(orgId, app);
}

// Cookie scoped to this app so app A's session is never sent to app B (defence
// in depth — the authorizer also validates against A's pool). On the path URL
// the scope is the app's path; on a vanity host it is Path=/ + Domain=<host>
// (the host itself is the isolation boundary).
function scopedCookie(name, orgId, app, value, maxAge, appHost) {
  const scope = appHost ? `Path=/; Domain=${appHost}` : `Path=/o/${orgId}/${app}/`;
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; ${scope}; Max-Age=${maxAge}`;
}
// How long the session cookie may live: exactly as long as the ID token it
// carries (Cognito's IdTokenValidity, 1 h by default). It used to be 24 h — so
// for 23 h a browser kept sending a token the authorizer could no longer
// verify, and the visitor's "session" was whatever the app's handler made of
// an anonymous request. Now the browser drops the cookie when the token dies,
// and the edge router (which can only see PRESENCE) sends the visitor back to
// /auth/login instead of the origin refusing them (t_frontend_auth_default).
function idTokenMaxAge(idToken, fallbackSeconds = 3600) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    const ttl = Math.floor(Number(payload.exp) - Date.now() / 1000);
    if (Number.isFinite(ttl) && ttl > 0) return Math.min(ttl, 86400);
  } catch (err) {
    // unreadable token → the fallback
  }
  return fallbackSeconds;
}
function idCookie(orgId, app, value, maxAge, appHost) {
  return scopedCookie(ID_TOKEN_COOKIE, orgId, app, value, maxAge, appHost);
}
function lastEmailCookie(orgId, app, email, appHost) {
  return scopedCookie(LAST_EMAIL_COOKIE, orgId, app, encodeURIComponent(email), LAST_EMAIL_MAX_AGE, appHost);
}
function passkeyDoneCookie(orgId, app, appHost) {
  return scopedCookie(PASSKEY_DONE_COOKIE, orgId, app, "1", PASSKEY_DONE_MAX_AGE, appHost);
}

// A passkey is bound to ONE relying party: the app's principal host (the
// connector's `passkey_rp_id` — its verified custom domain, else its vanity
// host). Only a login page served ON that host (or a subdomain of it) may offer
// it; the staging host, a secondary domain and the path URL keep the OTP.
// Browsers enforce the very same rule — this gate just keeps the button (and
// the register offer) from appearing where it could only fail.
function passkeyHostMatches(appHost, rpId) {
  if (!appHost || !rpId) return false;
  const h = String(appHost).toLowerCase();
  const r = String(rpId).toLowerCase();
  return h === r || h.endsWith("." + r);
}
function passkeysAvailable(appAuth, appHost) {
  return !!(appAuth && appAuth.passkeys && passkeyHostMatches(appHost, appAuth.passkeyRpId));
}

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
  for (const c of event.cookies || []) Object.assign(cookies, parseCookieHeader(c));
  const h = event.headers || {};
  Object.assign(cookies, parseCookieHeader(h.cookie || h.Cookie));
  return cookies;
}

function isUnexpiredJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    );
    const now = Math.floor(Date.now() / 1000);
    return !(typeof payload.exp === "number" && payload.exp < now);
  } catch {
    return false;
  }
}

// --- Route handlers -------------------------------------------------------

async function handleLogin(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const returnUrl = event.queryStringParameters?.return_url || "";
  const lang = detectLang(event);

  const cookies = collectCookies(event);
  if (cookies[ID_TOKEN_COOKIE] && isUnexpiredJwt(cookies[ID_TOKEN_COOKIE])) {
    return { statusCode: 302, headers: { Location: safeReturnUrl(returnUrl, orgId, app, appHost) }, body: "" };
  }

  let prefillEmail = event.queryStringParameters?.email || "";
  if (!prefillEmail && cookies[LAST_EMAIL_COOKIE]) {
    try {
      prefillEmail = decodeURIComponent(cookies[LAST_EMAIL_COOKIE]);
    } catch {
      prefillEmail = "";
    }
  }
  const appAuth = await resolveAppAuth(orgId, app);
  const branding = await resolveBranding(orgId, app);
  return htmlResponse(200, loginPage(returnUrl, null, branding, lang, prefillEmail, passkeysAvailable(appAuth, appHost)));
}

async function handleSendOtp(event, ctx) {
  const { orgId, app } = ctx;
  const params = parseBody(event);
  const email = (params.email || "").trim();
  const returnUrl = params.return_url || "";
  const isResend = params.resend === "1";
  const lang = detectLang(event);
  const s = t(lang);
  const branding = await resolveBranding(orgId, app);
  // A passkey attempt that could not complete lands here with the reason —
  // the OTP page says so, instead of looking like an unexplained detour.
  const notice = isResend ? s.codeResent : params.passkey_fallback ? s.passkeyFallback : null;

  if (!email) return htmlResponse(400, loginPage(returnUrl, s.emailRequired, branding, lang, ""));

  const appAuth = await resolveAppAuth(orgId, app);
  if (!appAuth) {
    // Auth not enabled / app not resolvable — fail closed.
    return htmlResponse(200, loginPage(returnUrl, s.noAccount, branding, lang, email));
  }

  // Allowlist gate (best-effort; null = couldn't check → let Cognito decide).
  const allowed = await isAllowlisted(orgId, appAuth.appId, email);
  if (allowed === false) {
    return htmlResponse(200, loginPage(returnUrl, s.noAccount, branding, lang, email));
  }

  try {
    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: appAuth.clientId,
        AuthParameters: { USERNAME: email },
      })
    );

    const otp = result.ChallengeParameters?.otp;
    if (otp) {
      const serverKey = await getPostmarkToken(orgId, app);
      await sendPostmarkEmail(email, s.emailSubject, s.emailBody(otp), {
        serverKey,
        fromEmail: appAuth.fromEmail,
      });
    }
    return htmlResponse(
      200,
      otpPage(result.Session, email, returnUrl, null, notice, branding, lang)
    );
  } catch (err) {
    console.error("auth-lambda: InitiateAuth error:", err?.name || err?.message || err);
    if (err.name === "UserNotFoundException" || err.name === "NotAuthorizedException") {
      return htmlResponse(200, loginPage(returnUrl, s.noAccount, branding, lang, email));
    }
    return htmlResponse(500, loginPage(returnUrl, s.sendFailed, branding, lang, email));
  }
}

async function handleVerify(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const params = parseBody(event);
  const { session, otp, email, return_url: returnUrl } = params;
  const lang = detectLang(event);
  const s = t(lang);
  const branding = await resolveBranding(orgId, app);

  if (!session || !otp || !email) {
    return htmlResponse(400, otpPage(session || "", email || "", returnUrl, s.missingFields, null, branding, lang));
  }

  const appAuth = await resolveAppAuth(orgId, app);
  if (!appAuth) {
    return htmlResponse(500, loginPage(returnUrl, s.authFailed, branding, lang, email));
  }

  try {
    const result = await cognitoClient.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "CUSTOM_CHALLENGE",
        ClientId: appAuth.clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, ANSWER: otp },
      })
    );

    if (result.AuthenticationResult?.IdToken) {
      const { IdToken: idToken, AccessToken: accessToken } = result.AuthenticationResult;
      const cookies = [
        idCookie(orgId, app, idToken, idTokenMaxAge(idToken), appHost),
        lastEmailCookie(orgId, app, email, appHost),
      ];
      let location = safeReturnUrl(returnUrl, orgId, app, appHost);
      // Passkey offer: only on the rpId host, only once per device, and the
      // AccessToken (what Start/CompleteWebAuthnRegistration authorize with)
      // travels in a 5-minute HttpOnly cookie — the session cookie is set
      // regardless, so declining or failing costs the user nothing.
      if (accessToken && passkeysAvailable(appAuth, appHost) && !collectCookies(event)[PASSKEY_DONE_COOKIE]) {
        cookies.push(scopedCookie(ACCESS_TOKEN_COOKIE, orgId, app, accessToken, ACCESS_TOKEN_MAX_AGE, appHost));
        location = `/auth/passkey/register?return_url=${encodeURIComponent(location)}`;
      }
      return { statusCode: 302, headers: { Location: location }, cookies, body: "" };
    }
    if (result.Session) {
      return htmlResponse(200, otpPage(result.Session, email, returnUrl, s.incorrectCode, null, branding, lang));
    }
    return htmlResponse(500, loginPage(returnUrl, s.authFailed, branding, lang, email));
  } catch (err) {
    console.error("auth-lambda: RespondToAuthChallenge error:", err?.name || err?.message || err);
    return htmlResponse(200, otpPage(session, email, returnUrl, s.expiredSession, null, branding, lang));
  }
}

async function handleLogout(event, ctx) {
  const { orgId, app, appHost } = ctx;
  return {
    statusCode: 302,
    headers: {
      Location: appHost ? "/auth/login" : `/o/${orgId}/${app}/auth/login`,
    },
    cookies: [idCookie(orgId, app, "", 0, appHost)],
    body: "",
  };
}

// --- Passkey routes (t_auth_passkey) -------------------------------------
//
// Sign-in: the page POSTs the e-mail → InitiateAuth(USER_AUTH, preferred
// WEB_AUTHN) → Cognito's CREDENTIAL_REQUEST_OPTIONS (a JSON string) go back to
// the browser → navigator.credentials.get → the AuthenticationResponseJSON is
// POSTed → RespondToAuthChallenge(WEB_AUTHN, CREDENTIAL = JSON string) → the
// SAME id-token cookie an OTP would set. Anything short of a token is a
// `fallback` the page turns into an e-mail code.

async function handlePasskeyStart(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const params = parseBody(event);
  const email = String(params.email || "").trim();
  const appAuth = await resolveAppAuth(orgId, app);
  if (!email || !passkeysAvailable(appAuth, appHost)) return jsonResponse(200, { fallback: "unavailable" });
  const allowed = await isAllowlisted(orgId, appAuth.appId, email);
  if (allowed === false) return jsonResponse(200, { fallback: "no_account" });
  try {
    const r = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_AUTH",
        ClientId: appAuth.clientId,
        AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "WEB_AUTHN" },
      })
    );
    // No passkey on this account (or an unknown e-mail — PreventUserExistenceErrors
    // answers the same way): Cognito offers its other factors → the e-mail code.
    const raw = r.ChallengeName === "WEB_AUTHN" ? r.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS : null;
    if (!raw || !r.Session) return jsonResponse(200, { fallback: "no_passkey" });
    return jsonResponse(200, { session: r.Session, options: JSON.parse(raw) });
  } catch (err) {
    console.error("auth-lambda: passkey InitiateAuth error:", err?.name || err?.message || err);
    return jsonResponse(200, { fallback: "error" });
  }
}

function credentialObject(value) {
  let cred = value;
  if (typeof cred === "string") {
    try {
      cred = JSON.parse(cred);
    } catch {
      return null;
    }
  }
  return cred && typeof cred === "object" && !Array.isArray(cred) ? cred : null;
}

async function handlePasskeyFinish(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const params = parseBody(event);
  const email = String(params.email || "").trim();
  const session = params.session;
  const credential = credentialObject(params.credential);
  if (!email || !session || !credential) return jsonResponse(200, { fallback: "error" });
  const appAuth = await resolveAppAuth(orgId, app);
  if (!passkeysAvailable(appAuth, appHost)) return jsonResponse(200, { fallback: "unavailable" });
  try {
    const r = await cognitoClient.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "WEB_AUTHN",
        ClientId: appAuth.clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, CREDENTIAL: JSON.stringify(credential) },
      })
    );
    const idToken = r.AuthenticationResult?.IdToken;
    if (!idToken) return jsonResponse(200, { fallback: "error" });
    return jsonResponse(200, { redirect: safeReturnUrl(params.return_url, orgId, app, appHost) }, [
      idCookie(orgId, app, idToken, idTokenMaxAge(idToken), appHost),
      lastEmailCookie(orgId, app, email, appHost),
      passkeyDoneCookie(orgId, app, appHost),
    ]);
  } catch (err) {
    console.error("auth-lambda: passkey RespondToAuthChallenge error:", err?.name || err?.message || err);
    return jsonResponse(200, { fallback: "error" });
  }
}

// Registration. The offer page exists only while the post-OTP AccessToken
// cookie does (5 min); without it — expired, declined earlier, direct hit —
// the user simply lands where they were going.
async function handlePasskeyRegisterPage(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const location = safeReturnUrl(event.queryStringParameters?.return_url, orgId, app, appHost);
  const appAuth = await resolveAppAuth(orgId, app);
  if (!collectCookies(event)[ACCESS_TOKEN_COOKIE] || !passkeysAvailable(appAuth, appHost)) {
    return { statusCode: 302, headers: { Location: location }, body: "" };
  }
  const branding = await resolveBranding(orgId, app);
  return htmlResponse(200, registerPage(location, branding, detectLang(event)));
}

async function handlePasskeyRegisterStart(event, ctx) {
  const accessToken = collectCookies(event)[ACCESS_TOKEN_COOKIE];
  if (!accessToken) return jsonResponse(401, { error: "no_session" });
  try {
    const r = await cognitoClient.send(new StartWebAuthnRegistrationCommand({ AccessToken: accessToken }));
    return jsonResponse(200, { options: r.CredentialCreationOptions });
  } catch (err) {
    console.error("auth-lambda: StartWebAuthnRegistration error:", err?.name || err?.message || err, ctx.app);
    return jsonResponse(200, { error: err?.name || "error" });
  }
}

// Cognito offers the WEB_AUTHN challenge ONLY to a CONFIRMED user. Every app
// user is admin-created and stays FORCE_CHANGE_PASSWORD (the OTP flow never
// touches the status) — a state in which USER_AUTH answers with password
// factors only, so a freshly registered passkey would never be usable. Proven
// in prod on 2026-09-13: same user, same credentials, SELECT_CHALLENGE
// [PASSWORD] before AdminSetUserPassword, WEB_AUTHN right after. So once a
// passkey is registered, the user gets a random PERMANENT password nobody
// knows (status → CONFIRMED). Nothing else changes: the e-mail code keeps
// working, no password can ever be typed.
function randomPermanentPassword() {
  return `Pk1!${crypto.randomBytes(24).toString("base64url")}aZ9`;
}
function accessTokenUsername(token) {
  try {
    const parts = String(token).split(".");
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof payload.username === "string" ? payload.username : null;
  } catch {
    return null;
  }
}
async function confirmPasskeyUser(appAuth, accessToken, app) {
  const username = accessTokenUsername(accessToken);
  if (!appAuth?.poolId || !username) return false;
  try {
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: appAuth.poolId,
        Username: username,
        Password: randomPermanentPassword(),
        Permanent: true,
      })
    );
    return true;
  } catch (err) {
    console.error("auth-lambda: passkey user confirmation failed (sign-in with the passkey will fall back to the code):", err?.name || err?.message || err, app);
    return false;
  }
}

async function handlePasskeyRegisterFinish(event, ctx) {
  const { orgId, app, appHost } = ctx;
  const accessToken = collectCookies(event)[ACCESS_TOKEN_COOKIE];
  if (!accessToken) return jsonResponse(401, { error: "no_session" });
  const credential = credentialObject(parseBody(event).credential);
  if (!credential) return jsonResponse(200, { ok: false, error: "missing_credential" });
  try {
    // Credential is a JSON OBJECT here (RegistrationResponseJSON) — unlike the
    // sign-in CREDENTIAL, which Cognito wants as a string.
    await cognitoClient.send(new CompleteWebAuthnRegistrationCommand({ AccessToken: accessToken, Credential: credential }));
    const confirmed = await confirmPasskeyUser(await resolveAppAuth(orgId, app), accessToken, app);
    return jsonResponse(200, { ok: true, confirmed }, [
      scopedCookie(ACCESS_TOKEN_COOKIE, orgId, app, "", 0, appHost),
      passkeyDoneCookie(orgId, app, appHost),
    ]);
  } catch (err) {
    console.error("auth-lambda: CompleteWebAuthnRegistration error:", err?.name || err?.message || err, app);
    return jsonResponse(200, { ok: false, error: err?.name || "error" });
  }
}

// --- Main handler ---------------------------------------------------------

exports.handler = async function (event) {
  const method = event.requestContext?.http?.method || "GET";
  const rawPath = event.rawPath || event.requestContext?.http?.path || "";
  const ctx = parsePath(rawPath);
  if (!ctx) return htmlResponse(404, "<h1>Not Found</h1>");
  // Vanity-host tag (absent on the path URL → unchanged behaviour).
  ctx.appHost = getAppHost(event);

  try {
    if (method === "GET" && ctx.action === "login") return await handleLogin(event, ctx);
    if (method === "POST" && ctx.action === "send-otp") return await handleSendOtp(event, ctx);
    if (method === "POST" && ctx.action === "verify") return await handleVerify(event, ctx);
    if (method === "GET" && ctx.action === "logout") return await handleLogout(event, ctx);
    if (method === "POST" && ctx.action === "passkey/start") return await handlePasskeyStart(event, ctx);
    if (method === "POST" && ctx.action === "passkey/finish") return await handlePasskeyFinish(event, ctx);
    if (method === "GET" && ctx.action === "passkey/register") return await handlePasskeyRegisterPage(event, ctx);
    if (method === "POST" && ctx.action === "passkey/register/start") return await handlePasskeyRegisterStart(event, ctx);
    if (method === "POST" && ctx.action === "passkey/register/finish") return await handlePasskeyRegisterFinish(event, ctx);
    return htmlResponse(404, "<h1>Not Found</h1>");
  } catch (err) {
    console.error("auth-lambda: unhandled error:", err?.message || err);
    return htmlResponse(500, "<h1>Internal Server Error</h1>");
  }
};

exports.__test__ = {
  parsePath,
  safeReturnUrl,
  idCookie,
  idTokenMaxAge,
  getAppHost,
  mintCapability,
  b64url,
  rowByName,
  sanitizeCss,
  loginPage,
  otpPage,
  registerPage,
  scopedCookie,
  passkeyHostMatches,
  dataApiQuery,
  RETRYABLE_STATUS,
  DATA_API_RETRIES,
};
