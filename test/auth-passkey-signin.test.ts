// Passkeys (t_auth_passkey) — the SIGN-IN routes of the auth Lambda:
// GET login (button gate + last-email prefill), POST passkey/start
// (InitiateAuth USER_AUTH, preferred WEB_AUTHN), POST passkey/finish
// (RespondToAuthChallenge WEB_AUTHN → the SAME session cookie as an OTP), and
// the OTP fallback notice. Cognito is mocked; the Data API + registry are faked.
const mockSend = jest.fn();
class Cmd { input: unknown; constructor(input: unknown) { this.input = input; } }
class InitiateAuthCommand extends Cmd {}
class RespondToAuthChallengeCommand extends Cmd {}
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand, RespondToAuthChallengeCommand, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => mockRegistry() }, GetCommand: class extends Cmd {} }), { virtual: true });

import { ev, installDataApiFake, registryFake, cookieNamed, RP, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
installDataApiFake();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/auth-lambda/index.js");
const run = (e: unknown) => handler(e) as Promise<Res>;
const json = (r: Res) => JSON.parse(r.body);
const lastInput = () => (mockSend.mock.calls.at(-1)![0] as Cmd).input as Record<string, unknown>;

beforeEach(() => mockSend.mockReset());

describe("GET login", () => {
  it("shows the passkey button on the rpId host when the app has passkeys on", async () => {
    const r = await run(ev("GET", "pk", "login", { query: { return_url: "/dash" } }));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="passkey-btn"');
  });
  it("hides it on another host of the same app, and for apps without passkeys", async () => {
    expect((await run(ev("GET", "pk", "login", { host: "pk-acme--stg.dilaya-apps.eu" }))).body).not.toContain('id="passkey-btn"');
    expect((await run(ev("GET", "nopk", "login"))).body).not.toContain('id="passkey-btn"');
    expect((await run(ev("GET", "pkoff", "login"))).body).not.toContain('id="passkey-btn"');
  });
  it("prefills the email from the dilaya_last_email cookie (query param wins)", async () => {
    const c = "dilaya_last_email=" + encodeURIComponent("jo@acme.fr");
    expect((await run(ev("GET", "pk", "login", { cookie: c }))).body).toContain('value="jo@acme.fr"');
    expect((await run(ev("GET", "pk", "login", { cookie: c, query: { email: "x@y.z" } }))).body).toContain('value="x@y.z"');
  });
});

describe("POST passkey/start", () => {
  it("asks Cognito for a WEB_AUTHN challenge and returns the parsed options + session", async () => {
    const opts = { challenge: "abc", rpId: RP, allowCredentials: [{ type: "public-key", id: "c1" }] };
    mockSend.mockResolvedValueOnce({ ChallengeName: "WEB_AUTHN", Session: "S1", ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(opts) } });
    const r = await run(ev("POST", "pk", "passkey/start", { json: { email: "jo@acme.fr" } }));
    expect(r.statusCode).toBe(200);
    expect(r.headers?.["Content-Type"]).toContain("application/json");
    expect(json(r)).toEqual({ session: "S1", options: opts });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(InitiateAuthCommand);
    expect(lastInput()).toEqual({ AuthFlow: "USER_AUTH", ClientId: "client-pk", AuthParameters: { USERNAME: "jo@acme.fr", PREFERRED_CHALLENGE: "WEB_AUTHN" } });
  });
  it("falls back when the user has no passkey (SELECT_CHALLENGE) or Cognito errors", async () => {
    mockSend.mockResolvedValueOnce({ ChallengeName: "SELECT_CHALLENGE", Session: "S2", AvailableChallenges: ["PASSWORD"] });
    expect(json(await run(ev("POST", "pk", "passkey/start", { json: { email: "jo@acme.fr" } })))).toEqual({ fallback: "no_passkey" });
    mockSend.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "InternalErrorException" }));
    expect(json(await run(ev("POST", "pk", "passkey/start", { json: { email: "jo@acme.fr" } })))).toEqual({ fallback: "error" });
  });
  it("is unavailable off the rpId host, for apps without passkeys, and without an email — no Cognito call", async () => {
    expect(json(await run(ev("POST", "pk", "passkey/start", { host: "other.acme.fr", json: { email: "jo@acme.fr" } })))).toEqual({ fallback: "unavailable" });
    expect(json(await run(ev("POST", "nopk", "passkey/start", { json: { email: "jo@acme.fr" } })))).toEqual({ fallback: "unavailable" });
    expect(json(await run(ev("POST", "pk", "passkey/start", { json: {} })))).toEqual({ fallback: "unavailable" });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it("accepts a form-encoded body too", async () => {
    mockSend.mockResolvedValueOnce({ ChallengeName: "SELECT_CHALLENGE", Session: "S2" });
    expect(json(await run(ev("POST", "pk", "passkey/start", { form: { email: "jo@acme.fr" } })))).toEqual({ fallback: "no_passkey" });
  });
});

describe("POST passkey/finish", () => {
  const credential = { id: "c1", rawId: "c1", type: "public-key", response: { signature: "sig" } };
  it("answers the WEB_AUTHN challenge with the credential as a JSON STRING and sets the session cookies", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: "ID.TOK.EN" } });
    const r = await run(ev("POST", "pk", "passkey/finish", { json: { session: "S1", email: "jo@acme.fr", credential, return_url: "/dash" } }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ redirect: "/dash" });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(RespondToAuthChallengeCommand);
    expect(lastInput()).toEqual({ ChallengeName: "WEB_AUTHN", ClientId: "client-pk", Session: "S1", ChallengeResponses: { USERNAME: "jo@acme.fr", CREDENTIAL: JSON.stringify(credential) } });
    expect(cookieNamed(r, "dilaya_id_token")).toBe(`dilaya_id_token=ID.TOK.EN; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=${RP}; Max-Age=3600`); // a fake token has no readable exp → the 1 h fallback (t_frontend_auth_default)
    expect(cookieNamed(r, "dilaya_last_email")).toContain("jo%40acme.fr; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=" + RP + "; Max-Age=7776000");
    expect(cookieNamed(r, "dilaya_pk")).toContain("dilaya_pk=1;");
  });
  it("keeps the anti-open-redirect rule on return_url", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: "ID.TOK.EN" } });
    const r = await run(ev("POST", "pk", "passkey/finish", { json: { session: "S1", email: "jo@acme.fr", credential, return_url: "https://evil.com/x" } }));
    expect(json(r)).toEqual({ redirect: "/" });
  });
  it("falls back (no cookie) when Cognito rejects the assertion or returns no token", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("bad"), { name: "NotAuthorizedException" }));
    const r = await run(ev("POST", "pk", "passkey/finish", { json: { session: "S1", email: "jo@acme.fr", credential } }));
    expect(json(r)).toEqual({ fallback: "error" });
    expect(r.cookies ?? []).toEqual([]);
    mockSend.mockResolvedValueOnce({ ChallengeName: "SELECT_CHALLENGE", Session: "S3" });
    expect(json(await run(ev("POST", "pk", "passkey/finish", { json: { session: "S1", email: "jo@acme.fr", credential } })))).toEqual({ fallback: "error" });
  });
  it("refuses an incomplete body without calling Cognito", async () => {
    expect(json(await run(ev("POST", "pk", "passkey/finish", { json: { email: "jo@acme.fr" } })))).toEqual({ fallback: "error" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("POST send-otp with passkey_fallback", () => {
  it("renders the OTP page with the fallback notice (FR / EN)", async () => {
    mockSend.mockResolvedValue({ Session: "S9", ChallengeParameters: {} });
    const fr = await run(ev("POST", "pk", "send-otp", { form: { email: "jo@acme.fr", return_url: "/dash", passkey_fallback: "no_passkey" } }));
    expect(fr.statusCode).toBe(200);
    expect(fr.body).toContain('<div class="notice">');
    expect(fr.body).toContain("passkey");
    const en = await run(ev("POST", "pk", "send-otp", { lang: "en", form: { email: "jo@acme.fr", passkey_fallback: "error" } }));
    expect(en.body).toContain("we emailed you a code");
    const plain = await run(ev("POST", "pk", "send-otp", { form: { email: "jo@acme.fr" } }));
    expect(plain.body).not.toContain('<div class="notice">');
  });
});
