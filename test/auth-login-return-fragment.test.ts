// The edge gate sends an anonymous visitor to /auth/login#r=<where they were>
// (t_login_return_fragment, 0.1.108). Four real RateGuardAlarm firings in 23 h
// (12-13/10/2026) were scanners probing hundreds of generic paths on closed
// sites; each `?return_url=` was a distinct cache key, so the login page's 60 s
// cache absorbed none of them (up to 174 origin renders a minute, 32 of the auth
// Lambda's 50 shared slots). A fragment never reaches the server nor the cache,
// so the page is ONE entry per site — and this script is what carries the path
// into the hidden field the forms POST, where safeReturnUrl validates it.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {}, StartWebAuthnRegistrationCommand: class {}, CompleteWebAuthnRegistrationCommand: class {}, AdminSetUserPasswordCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }), { virtual: true });

export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { loginPage, otpPage, RETURN_FRAGMENT_SCRIPT } = __test__;

/** Run the inline script against a fake `location` + one hidden input. */
function runScript(hash: string, initial = "") {
  const body = (RETURN_FRAGMENT_SCRIPT as string).replace(/<\/?script>/g, "");
  const field = { value: initial };
  const document = { querySelector: (sel: string) => (sel === "input[name=return_url]" ? field : null) };
  new Function("location", "document", body)({ hash }, document);
  return field.value;
}

describe("the login page's return-path fragment", () => {
  it("renders the hidden return_url EMPTY when the server got none, and ships the fragment script", () => {
    const html: string = loginPage("", null, null, "fr", "");
    expect(html).toContain('<input type="hidden" name="return_url" value="">');
    expect(html).toContain("location.hash");
    expect(html).toContain("input[name=return_url]");
  });

  it("keeps a server-supplied return_url (the OTP page's back link still uses the query)", () => {
    const html: string = loginPage("/orders/42?tab=open", null, null, "en", "");
    expect(html).toContain('<input type="hidden" name="return_url" value="/orders/42?tab=open">');
  });

  it("copies #r=<encoded path> into the field — the exact value the edge gate encodes", () => {
    const ret = "/orders/42?tab=open&x=1";
    expect(runScript("#r=" + encodeURIComponent(ret))).toBe(ret);
    expect(runScript("#r=" + encodeURIComponent("/form/"))).toBe("/form/");
  });

  it("never overrides a field the server filled, and leaves it empty without a fragment", () => {
    expect(runScript("#r=%2Fx", "/server")).toBe("/server");
    expect(runScript("")).toBe("");
    expect(runScript("#other=1")).toBe("");
    expect(runScript("#r=%2Fx&other=1")).toBe("/x");
  });

  it("swallows a malformed fragment instead of throwing on the page", () => {
    expect(() => runScript("#r=%E0%A4%A")).not.toThrow();
    expect(runScript("#r=%E0%A4%A")).toBe("");
  });

  it("is not on the OTP page (that page is per e-mail and never cached)", () => {
    const html: string = otpPage("S", "jo@acme.fr", "/x", null, null, null, "fr");
    expect(html).not.toContain("location.hash");
  });
});
