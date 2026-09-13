// Passkeys (t_auth_passkey) — pure seams of the auth Lambda: the host-vs-rpId
// gate, the integer-aware row reader, the scoped cookie helper, and the
// login / register page renderers.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {}, StartWebAuthnRegistrationCommand: class {}, CompleteWebAuthnRegistrationCommand: class {}, AdminSetUserPasswordCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { rowByName, passkeyHostMatches, scopedCookie, loginPage, registerPage, otpPage } = __test__;

describe("passkeyHostMatches — a passkey is bound to ONE relying party", () => {
  it("matches the rpId itself and its subdomains, case-insensitively", () => {
    expect(passkeyHostMatches("www.acme.fr", "www.acme.fr")).toBe(true);
    expect(passkeyHostMatches("shop.acme.fr", "acme.fr")).toBe(true);
    expect(passkeyHostMatches("WWW.ACME.FR", "www.acme.fr")).toBe(true);
  });
  it("rejects another host, a suffix-only match, the path URL (no host) and a missing rpId", () => {
    expect(passkeyHostMatches("pk-acme.dilaya-apps.eu", "www.acme.fr")).toBe(false);
    expect(passkeyHostMatches("evilacme.fr", "acme.fr")).toBe(false);
    expect(passkeyHostMatches(null, "acme.fr")).toBe(false);
    expect(passkeyHostMatches("acme.fr", null)).toBe(false);
  });
});

describe("rowByName — integer columns (passkeys) survive the read", () => {
  it("maps longValue to a number and keeps strings/nulls as before", () => {
    const res = {
      columnMetadata: [{ name: "user_pool_client_id" }, { name: "passkeys" }, { name: "passkey_rp_id" }],
      records: [[{ stringValue: "c1" }, { longValue: 1 }, { isNull: true }]],
    };
    expect(rowByName(res)).toEqual({ user_pool_client_id: "c1", passkeys: 1, passkey_rp_id: null });
  });
});

describe("scopedCookie — same scope rules as the session cookie", () => {
  it("vanity host: Path=/ + Domain=<host>; path URL: app path", () => {
    expect(scopedCookie("dilaya_at", "o", "a", "tok", 300, "www.acme.fr")).toBe(
      "dilaya_at=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=www.acme.fr; Max-Age=300"
    );
    expect(scopedCookie("dilaya_at", "o", "a", "", 0, null)).toBe(
      "dilaya_at=; HttpOnly; Secure; SameSite=Lax; Path=/o/o/a/; Max-Age=0"
    );
  });
});

describe("loginPage — the passkey button only when the flag says so", () => {
  it("passkeys off (default): no button, no WebAuthn script", () => {
    const html = loginPage("/ret", null, null, "fr", "");
    expect(html).not.toContain('id="passkey-btn"');
    expect(html).not.toContain("navigator.credentials");
  });
  it("passkeys on: hidden button (JS reveals it), start/finish endpoints, fallback field, i18n label", () => {
    const html = loginPage("/ret", null, null, "fr", "a@b.fr", true);
    expect(html).toContain('id="passkey-btn"');
    expect(html).toContain("hidden");
    expect(html).toContain("navigator.credentials.get");
    expect(html).toContain('"passkey/start"');
    expect(html).toContain('"passkey/finish"');
    expect(html).toContain('name="passkey_fallback"');
    expect(html).toContain("Se connecter avec une passkey");
    expect(loginPage("/ret", null, null, "en", "", true)).toContain("Sign in with a passkey");
  });
});

// The pages use RELATIVE endpoints, resolved by the browser against the page's
// own URL. The login page lives at /auth/login (base /auth/), the offer page at
// /auth/passkey/register (base /auth/passkey/): the SAME literal resolves to
// different paths. Shipped wrong on 2026-09-13 (0.1.68: "passkey/register/start"
// from the offer page → /auth/passkey/passkey/register/start → 404, instant
// "could not be set up"). Resolve like the browser does, on both URL shapes.
describe("relative endpoints resolve to the Lambda's routes from each page's own URL", () => {
  const endpoints = (html: string) => [...html.matchAll(/post\("([^"]+)"/g)].map((m) => m[1]!);
  const resolve = (rel: string, page: string) => new URL(rel, page).pathname;
  it("login page → /auth/passkey/{start,finish} on a host, and under /o/… on the path URL", () => {
    const eps = endpoints(loginPage("/ret", null, null, "fr", "", true));
    expect(eps.map((e) => resolve(e, "https://app.acme.fr/auth/login?return_url=%2F"))).toEqual(["/auth/passkey/start", "/auth/passkey/finish"]);
    expect(eps.map((e) => resolve(e, "https://app.dilaya.eu/o/org/app/auth/login"))).toEqual(["/o/org/app/auth/passkey/start", "/o/org/app/auth/passkey/finish"]);
  });
  it("offer page → /auth/passkey/register/{start,finish} on a host, and under /o/… on the path URL", () => {
    const eps = endpoints(registerPage("/ret", null, "fr"));
    expect(eps.map((e) => resolve(e, "https://app.acme.fr/auth/passkey/register?return_url=%2F"))).toEqual(["/auth/passkey/register/start", "/auth/passkey/register/finish"]);
    expect(eps.map((e) => resolve(e, "https://app.dilaya.eu/o/org/app/auth/passkey/register"))).toEqual(["/o/org/app/auth/passkey/register/start", "/o/org/app/auth/passkey/register/finish"]);
  });
});

describe("registerPage — the post-OTP offer", () => {
  it("renders branded, with the register endpoints and an escaped 'later' link", () => {
    const html = registerPage('/ret?x=1"', { loginTitle: "Mon espace", logoUrl: "https://x.fr/l.png" }, "fr");
    expect(html).toContain("<title>Mon espace</title>");
    expect(html).toContain('class="login-logo" src="https://x.fr/l.png"');
    expect(html).toContain("Enregistrer une passkey");
    expect(html).toContain('post("register/start"');
    expect(html).toContain('post("register/finish"');
    expect(html).toContain("navigator.credentials.create");
    expect(html).toContain('href="/ret?x=1&quot;"');
    expect(html).toContain("Plus tard");
  });
  it("english copy", () => {
    const html = registerPage("/ret", null, "en");
    expect(html).toContain("Set up a passkey");
    expect(html).toContain("Not now");
  });
});

describe("otpPage — passkey fallback notice rides the existing notice slot", () => {
  it("shows the notice text when given", () => {
    const html = otpPage("s", "a@b.fr", "/r", null, "La passkey n’a pas pu être utilisée", null, "fr");
    expect(html).toContain('<div class="notice">La passkey n’a pas pu être utilisée</div>');
  });
});
