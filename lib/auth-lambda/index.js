const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require("@aws-sdk/client-rds-data");
const https = require("https");

// ---------------------------------------------------------------------------
// i18n — English / French
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
    otpSubtitle: (email) => `Nous avons envoy\u00e9 un code \u00e0 6 chiffres \u00e0 <strong>${email}</strong>.`,
    otpLabel: "Code de v\u00e9rification",
    verifyButton: "V\u00e9rifier",
    emailRequired: "L\u2019adresse email est requise.",
    noAccount: "Aucun compte trouv\u00e9 pour cet email. Contactez le propri\u00e9taire de l\u2019application.",
    sendFailed: "\u00c9chec de l\u2019envoi du code. Veuillez r\u00e9essayer.",
    missingFields: "Champs requis manquants.",
    incorrectCode: "Code incorrect. Veuillez r\u00e9essayer.",
    expiredSession: "Code incorrect ou session expir\u00e9e. Veuillez r\u00e9essayer.",
    authFailed: "\u00c9chec de l\u2019authentification.",
    emailSubject: "Votre code de v\u00e9rification",
    emailBody: (otp) => `<p>Votre code de v\u00e9rification est\u00a0: <strong>${otp}</strong></p><p>Ce code expire dans 5 minutes.</p>`,
    codeResent: "Un nouveau code a \u00e9t\u00e9 envoy\u00e9 \u00e0 votre email.",
    resendButton: "Renvoyer le code",
    backToEmail: "Utiliser un autre email",
    loadingContinue: "Envoi\u2026",
    loadingVerify: "V\u00e9rification\u2026",
    loadingResend: "Envoi\u2026",
  },
};

function detectLang(event) {
  const accept = event.headers?.["accept-language"] || event.headers?.["Accept-Language"] || "";
  return accept.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function t(lang) {
  return i18n[lang] || i18n.en;
}

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION,
});
const secretsClient = new SecretsManagerClient({});
const s3Client = new S3Client({});
const ssmClient = new SSMClient({});
const rdsClient = new RDSDataClient({});

// Shared-pool fallbacks (Phase A). For apps that have called `enable-auth`,
// resolveAppAuth() returns per-app values and these are ignored.
const SHARED_USER_POOL_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const ORGANIZATION_ID = process.env.ORGANIZATION_ID;

const CLUSTER_ARN = process.env.clusterArn;
const SECRET_ARN = process.env.secretArn;
const DATABASE_NAME = process.env.databaseName;

// Per-app resolve cache — short TTL so enable-auth takes effect quickly.
const appAuthCache = new Map();
const APP_AUTH_TTL_MS = 60 * 1000;

async function resolveAppAuth(schema) {
  if (!schema) return null;
  const hit = appAuthCache.get(schema);
  if (hit && Date.now() - hit.at < APP_AUTH_TTL_MS) return hit.value;

  if (!CLUSTER_ARN || !SECRET_ARN || !DATABASE_NAME) return null;
  try {
    const row = await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        sql: `SELECT user_pool_client_id, from_email FROM public._app_auth WHERE schema_name = :schema`,
        parameters: [{ name: "schema", value: { stringValue: schema } }],
      })
    );
    if (!row.records || row.records.length === 0) {
      appAuthCache.set(schema, { value: null, at: Date.now() });
      return null;
    }
    const clientId = row.records[0][0].stringValue;
    const defaultFromEmail = row.records[0][1].stringValue;

    // Prefer an active vanity domain as the OTP sender when one exists. The
    // canonical_domain on _custom_domains is the host the user shares; using
    // it for `noreply@` keeps the From address aligned with the URL the user
    // is logging in to (otherwise they see emails arriving from the internal
    // `{schema}.{customDomain}` subdomain even though they're on a vanity
    // host). email_status='active' guarantees Postmark has a verified
    // signature for the domain so the send won't be rejected. If multiple
    // rows exist for the schema they share the same canonical by design;
    // picking max(canonical_domain) collapses them to one deterministic
    // value. Falls back silently to the stored _app_auth.from_email when
    // the table doesn't exist (pre-custom-domains deployments) or no row
    // qualifies.
    let fromEmail = defaultFromEmail;
    try {
      const cd = await rdsClient.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql: `SELECT MAX(canonical_domain) AS canonical
                  FROM public._custom_domains
                 WHERE schema_name = :schema
                   AND status = 'active'
                   AND email_status = 'active'
                   AND canonical_domain IS NOT NULL`,
          parameters: [{ name: "schema", value: { stringValue: schema } }],
        })
      );
      const canonical = cd.records?.[0]?.[0]?.stringValue;
      if (canonical) {
        fromEmail = `noreply@${canonical}`;
      }
    } catch (err) {
      // _custom_domains may not exist yet in a freshly-deployed org, or the
      // table may be mid-migration. Non-fatal — fall back to the stored
      // default so OTP delivery keeps working.
      console.error(
        "resolveAppAuth: _custom_domains lookup failed, using default from_email:",
        err?.name || err?.message || err
      );
    }

    // Postmark server token lives in SSM SecureString per-app.
    let postmarkServerToken = null;
    try {
      const param = await ssmClient.send(
        new GetParameterCommand({
          Name: `/hereya/${ORGANIZATION_ID}/apps/${schema}/auth/postmark-server-token`,
          WithDecryption: true,
        })
      );
      postmarkServerToken = param.Parameter?.Value ?? null;
    } catch (err) {
      if (err?.name !== "ParameterNotFound") {
        console.error("SSM GetParameter failed for", schema, err);
      }
    }
    const value = { clientId, fromEmail, postmarkServerToken };
    appAuthCache.set(schema, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.error("resolveAppAuth _app_auth lookup failed:", err);
    return null;
  }
}

// Derive the cookie Domain attribute from the viewer's Host so the same auth
// flow works on default subdomains (`.${CUSTOM_DOMAIN}`) and user-bound vanity
// domains. CloudFront's OriginRequestPolicy does not forward the viewer Host
// header — CloudFront replaces it with the API Gateway origin domain — so we
// rely on the CloudFront Function to copy the original Host into
// `x-forwarded-host` before we read it here. Fallback logic keeps default
// subdomains working even when the CF function hasn't been regenerated yet
// with that propagation.
function getCookieDomain(event) {
  const headers = event.headers || {};
  const rawHost =
    headers["x-forwarded-host"] ||
    headers["X-Forwarded-Host"] ||
    headers.host ||
    headers.Host ||
    "";
  const host = String(rawHost).split(":")[0].toLowerCase();
  if (
    CUSTOM_DOMAIN &&
    (host === CUSTOM_DOMAIN || host.endsWith("." + CUSTOM_DOMAIN))
  ) {
    return "." + CUSTOM_DOMAIN;
  }
  // Vanity host recognized via x-forwarded-host — scope cookie to it.
  if (host && !host.endsWith(".amazonaws.com")) {
    return host;
  }
  // Fallback: no viewer-host signal (CF function hasn't been regenerated
  // with x-forwarded-host yet, so Host is the API Gateway origin). Default
  // to the customDomain namespace so default subdomains still work.
  return CUSTOM_DOMAIN ? "." + CUSTOM_DOMAIN : "";
}

// ---------------------------------------------------------------------------
// Per-app custom CSS loading from S3
// ---------------------------------------------------------------------------

const cssCache = {};

async function loadCustomCss(app) {
  if (!app) return null;
  if (app in cssCache) return cssCache[app];
  const bucket = process.env.BUCKET_NAME;
  const prefix = process.env.S3_PREFIX;
  if (!bucket) {
    console.log("loadCustomCss: no BUCKET_NAME env var");
    cssCache[app] = null;
    return null;
  }
  const key = prefix ? `${prefix}/${app}/auth/custom.css` : `${app}/auth/custom.css`;
  console.log(`loadCustomCss: loading s3://${bucket}/${key}`);
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    cssCache[app] = await result.Body.transformToString("utf-8");
    console.log(`loadCustomCss: loaded ${cssCache[app].length} bytes`);
  } catch (err) {
    console.log(`loadCustomCss: ${err.name || err.message || err}`);
    cssCache[app] = null;
  }
  return cssCache[app];
}

function getSharedSenderEmail() {
  // Fallback only — per-app senders come from resolveAppAuth().fromEmail.
  // customDomain = "jnj-space.hereyalab.dev" → "auth.jnj-space@hereyalab.dev"
  const parts = (CUSTOM_DOMAIN || "").split(".");
  const org = parts[0];
  const rootDomain = parts.slice(1).join(".");
  return `auth.${org}@${rootDomain}`;
}

// ---------------------------------------------------------------------------
// Secrets resolution (same pattern as main handler)
// ---------------------------------------------------------------------------

let secretsResolved = false;

async function resolveSecrets() {
  if (secretsResolved) return;
  const keys = (process.env.SECRET_KEYS || "").split(",").filter(Boolean);
  for (const key of keys) {
    const secretName = process.env[key];
    if (!secretName) continue;
    try {
      const result = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      process.env[key] = result.SecretString;
    } catch (err) {
      console.error(`Failed to resolve secret ${key}:`, err);
    }
  }
  secretsResolved = true;
}

// ---------------------------------------------------------------------------
// Postmark email sending
// ---------------------------------------------------------------------------

function sendPostmarkEmail(to, subject, htmlBody, opts) {
  const serverKey =
    opts?.serverKey ||
    process.env.postmarkServerKey ||
    process.env.POSTMARK_SERVER_KEY;
  if (!serverKey) {
    console.error("No Postmark server key available");
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    From: opts?.fromEmail || getSharedSenderEmail(),
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function loginPage(returnUrl, error, customCss, lang, prefillEmail) {
  const s = t(lang || "en");
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${s.loginTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #111; }
    p { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    label { display: block; font-size: 0.85rem; font-weight: 500; color: #333; margin-bottom: 6px; }
    input[type=email] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px;
                         font-size: 1rem; outline: none; }
    input[type=email]:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
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
  </style>
  ${customCss ? `<style>${customCss}</style>` : ""}
</head>
<body>
  <div class="card">
    <h1>${s.loginTitle}</h1>
    <p>${s.loginSubtitle}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="send-otp">
      <input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
      <label for="email">${s.emailLabel}</label>
      <input type="email" id="email" name="email" required autofocus placeholder="${s.emailPlaceholder}" value="${escapeHtml(prefillEmail || "")}">
      <button type="submit" data-loading-label="${escapeHtml(s.loadingContinue)}">${s.continueButton}</button>
    </form>
  </div>
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
  </script>
</body>
</html>`;
}

function otpPage(session, email, returnUrl, error, notice, customCss, lang) {
  const s = t(lang || "en");
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${s.otpLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
            padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #111; }
    p { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    label { display: block; font-size: 0.85rem; font-weight: 500; color: #333; margin-bottom: 6px; }
    input[type=text] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px;
                        font-size: 1.5rem; text-align: center; letter-spacing: 0.3em; outline: none; }
    input[type=text]:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
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
  </style>
  ${customCss ? `<style>${customCss}</style>` : ""}
</head>
<body>
  <div class="card">
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
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString()
    : event.body || "";
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}

// Extract the app name from path: /{app}/auth/... → app
function extractApp(rawPath) {
  const match = rawPath.match(/^\/([a-z][a-z0-9_-]*)\/auth\//i);
  return match ? match[1] : null;
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

function isValidJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    return !(typeof payload.exp === "number" && payload.exp < now);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(event) {
  const returnUrl = event.queryStringParameters?.return_url || "";
  const prefillEmail = event.queryStringParameters?.email || "";
  const app = extractApp(event.rawPath);
  const lang = detectLang(event);

  // If user already has a valid JWT cookie, redirect to return_url or root
  const cookieHeader = event.headers?.cookie ?? event.headers?.Cookie ?? "";
  const cookies = parseCookies(cookieHeader);
  if (cookies["hereya_id_token"] && isValidJwt(cookies["hereya_id_token"])) {
    return {
      statusCode: 302,
      headers: { Location: returnUrl || "/" },
      body: "",
    };
  }

  const css = await loadCustomCss(app);
  return htmlResponse(200, loginPage(returnUrl, null, css, lang, prefillEmail));
}

async function handleSendOtp(event) {
  const params = parseBody(event);
  const email = params.email;
  const returnUrl = params.return_url || "";
  const isResend = params.resend === "1";

  const app = extractApp(event.rawPath);
  const lang = detectLang(event);
  const s = t(lang);
  const css = await loadCustomCss(app);

  if (!email) {
    return htmlResponse(400, loginPage(returnUrl, s.emailRequired, css, lang, ""));
  }

  const appAuth = await resolveAppAuth(app);
  const clientId = appAuth?.clientId || SHARED_USER_POOL_CLIENT_ID;

  try {
    // No auto-signup — only pre-registered users can log in.
    // Users are added by the agent via the add-user MCP tool.
    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
        },
      })
    );

    // aws/cognito returns OTP in ChallengeParameters — we send it via Postmark
    const otp = result.ChallengeParameters?.otp;
    if (otp) {
      await sendPostmarkEmail(email, s.emailSubject, s.emailBody(otp), {
        serverKey: appAuth?.postmarkServerToken,
        fromEmail: appAuth?.fromEmail,
      });
    }

    const session = result.Session;
    return htmlResponse(200, otpPage(session, email, returnUrl, null, isResend ? s.codeResent : null, css, lang));
  } catch (err) {
    console.error("InitiateAuth error:", err);
    if (err.name === "UserNotFoundException" || err.name === "NotAuthorizedException") {
      return htmlResponse(200, loginPage(returnUrl, s.noAccount, css, lang, email));
    }
    return htmlResponse(500, loginPage(returnUrl, s.sendFailed, css, lang, email));
  }
}

async function handleVerify(event) {
  const params = parseBody(event);
  const { session, otp, email, return_url: returnUrl } = params;
  const app = extractApp(event.rawPath);
  const lang = detectLang(event);
  const s = t(lang);
  const css = await loadCustomCss(app);

  if (!session || !otp || !email) {
    return htmlResponse(400, otpPage(session || "", email || "", returnUrl, s.missingFields, null, css, lang));
  }

  const appAuth = await resolveAppAuth(app);
  const clientId = appAuth?.clientId || SHARED_USER_POOL_CLIENT_ID;

  try {
    const result = await cognitoClient.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "CUSTOM_CHALLENGE",
        ClientId: clientId,
        Session: session,
        ChallengeResponses: {
          USERNAME: email,
          ANSWER: otp,
        },
      })
    );

    if (result.AuthenticationResult?.IdToken) {
      const idToken = result.AuthenticationResult.IdToken;

      // Redirect path — no app prefix (CloudFront adds it from subdomain)
      const redirectPath = returnUrl || "/";

      return {
        statusCode: 302,
        headers: {
          Location: redirectPath,
          "Set-Cookie": `hereya_id_token=${idToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=${getCookieDomain(event)}; Max-Age=86400`,
        },
        body: "",
      };
    }

    // Challenge not yet complete (shouldn't happen with correct OTP)
    if (result.Session) {
      return htmlResponse(
        200,
        otpPage(result.Session, email, returnUrl, s.incorrectCode, null, css, lang)
      );
    }

    return htmlResponse(500, loginPage(returnUrl, s.authFailed, css, lang, email));
  } catch (err) {
    console.error("RespondToAuthChallenge error:", err);
    return htmlResponse(
      200,
      otpPage(session, email, returnUrl, s.expiredSession, null, css, lang)
    );
  }
}

async function handleLogout(event) {
  return {
    statusCode: 302,
    headers: {
      Location: "/auth/login",
      "Set-Cookie": `hereya_id_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=${getCookieDomain(event)}; Max-Age=0`,
    },
    body: "",
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  const method = event.requestContext?.http?.method || "GET";
  const rawPath = event.rawPath || "";

  // Strip the /{app}/auth prefix to get the action
  const authMatch = rawPath.match(/\/[a-z][a-z0-9_-]*\/auth\/(.+)$/i);
  const action = authMatch ? authMatch[1] : "";

  await resolveSecrets();

  try {
    if (method === "GET" && action === "login") {
      return await handleLogin(event);
    }
    if (method === "POST" && action === "send-otp") {
      return await handleSendOtp(event);
    }
    if (method === "POST" && action === "verify") {
      return await handleVerify(event);
    }
    if (method === "GET" && action === "logout") {
      return await handleLogout(event);
    }

    return htmlResponse(404, "<h1>Not Found</h1>");
  } catch (err) {
    console.error("Auth Lambda error:", err);
    return htmlResponse(500, "<h1>Internal Server Error</h1>");
  }
};
