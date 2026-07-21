"use strict";
// ---------------------------------------------------------------------------
// Multi-tenant auth Lambda (v2 / SQLite).
//
// Serves the passwordless email-OTP login flow for per-app web frontends. A
// SINGLE Lambda serves EVERY org/app; org + app come from the request PATH:
//   ANY /o/{orgId}/{app}/auth/{login|send-otp|verify|logout}
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
          clientId: row.user_pool_client_id,
          fromEmail: row.from_email || null,
          branding: {
            customCss: row.custom_css || null,
            loginTitle: row.login_title || null,
            logoUrl: row.logo_url || null,
          },
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

function loginPage(returnUrl, error, branding, lang, prefillEmail) {
  const s = t(lang || "en");
  const b = branding || {};
  const title = b.loginTitle ? escapeHtml(b.loginTitle) : s.loginTitle;
  const logo = b.logoUrl ? `<img class="login-logo" src="${escapeHtml(b.logoUrl)}" alt="">` : "";
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
    </form>
  </div>
  ${SUBMIT_SCRIPT}
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

function parseBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString()
    : event.body || "";
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function htmlResponse(statusCode, html) {
  return { statusCode, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
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

// Only allow local, single-slash redirect targets. On a vanity host the app is
// rooted, so the default (no return_url) is `/`; on the path URL it's the app's
// /site prefix.
function safeReturnUrl(raw, orgId, app, appHost) {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return appHost ? "/" : sitePrefix(orgId, app);
}

// Cookie scoped to this app so app A's session is never sent to app B (defence
// in depth — the authorizer also validates against A's pool). On the path URL
// the scope is the app's path; on a vanity host it is Path=/ + Domain=<host>
// (the host itself is the isolation boundary).
function idCookie(orgId, app, value, maxAge, appHost) {
  if (appHost) {
    return `${ID_TOKEN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=${appHost}; Max-Age=${maxAge}`;
  }
  return `${ID_TOKEN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/o/${orgId}/${app}/; Max-Age=${maxAge}`;
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
  const prefillEmail = event.queryStringParameters?.email || "";
  const lang = detectLang(event);

  const cookies = collectCookies(event);
  if (cookies[ID_TOKEN_COOKIE] && isUnexpiredJwt(cookies[ID_TOKEN_COOKIE])) {
    return { statusCode: 302, headers: { Location: safeReturnUrl(returnUrl, orgId, app, appHost) }, body: "" };
  }

  const branding = await resolveBranding(orgId, app);
  return htmlResponse(200, loginPage(returnUrl, null, branding, lang, prefillEmail));
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
      otpPage(result.Session, email, returnUrl, null, isResend ? s.codeResent : null, branding, lang)
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
      const idToken = result.AuthenticationResult.IdToken;
      return {
        statusCode: 302,
        headers: { Location: safeReturnUrl(returnUrl, orgId, app, appHost) },
        cookies: [idCookie(orgId, app, idToken, 86400, appHost)],
        body: "",
      };
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
  getAppHost,
  mintCapability,
  b64url,
  rowByName,
  sanitizeCss,
  loginPage,
  otpPage,
};
