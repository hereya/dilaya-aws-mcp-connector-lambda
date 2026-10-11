// The anonymous login page is the ONE response the auth Lambda marks cacheable
// (t_login_burst_authlambda, 2026-10-11): `max-age=0, s-maxage=60` — the CDN
// keeps it a minute, the browser revalidates as before. 10/10: one address
// loaded a login page 101 times in 10 s and held 29 of the Lambda's 50 shared
// slots; cached, that burst costs the origin one render. Everything else this
// Lambda answers is per-visitor (a redirect for a signed-in visitor, an OTP
// page for one e-mail, JSON for one passkey ceremony) and must stay uncached.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {}, StartWebAuthnRegistrationCommand: class {}, CompleteWebAuthnRegistrationCommand: class {}, AdminSetUserPasswordCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { loginPageResponse, LOGIN_PAGE_CACHE_CONTROL, loginPage, otpPage } = __test__;

describe("the login page's Cache-Control", () => {
  it("is a CDN-only minute: s-maxage=60, max-age=0, no `public` for other shared caches", () => {
    expect(LOGIN_PAGE_CACHE_CONTROL).toBe("max-age=0, s-maxage=60");
    const res = loginPageResponse(loginPage("/ret", null, null, "fr", ""));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("max-age=0, s-maxage=60");
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    // Nothing per-visitor rides on it: no cookie is set on the cached page.
    expect(res.cookies).toBeUndefined();
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("the page itself carries no CSRF token or nonce that a shared copy would leak", () => {
    const html: string = loginPage("/ret", null, null, "en", "");
    expect(html).not.toMatch(/csrf|nonce/i);
  });

  it("is the ONLY place the header is set: one call site, every other page goes out bare", () => {
    const src: string = require("fs").readFileSync(require.resolve("../lib/auth-lambda/index.js"), "utf8");
    // The declaration and handleLogin's single call — no other page renders
    // through loginPageResponse (an OTP page is for one e-mail, a redirect for
    // one visitor; a shared copy of either would be a leak, not a cache).
    expect(src.split("loginPageResponse(").length - 1).toBe(2);
    // Two Cache-Control literals in the whole Lambda: this one, and the
    // `no-store` every JSON answer carries.
    expect(src.split('"Cache-Control"').length - 1).toBe(2);
    expect(src).toContain('"Cache-Control": "no-store"');
  });
});
