// Passkeys (t_auth_passkey) — the REGISTRATION leg of the auth Lambda: after a
// successful OTP, POST verify redirects to the offer page (only on the rpId
// host, only when the device has not registered yet) carrying the fresh
// AccessToken in a short HttpOnly cookie; GET passkey/register renders the
// offer; POST passkey/register/start|finish drive Start/CompleteWebAuthnRegistration.
const mockSend = jest.fn();
class Cmd { input: unknown; constructor(input: unknown) { this.input = input; } }
class StartWebAuthnRegistrationCommand extends Cmd {}
class CompleteWebAuthnRegistrationCommand extends Cmd {}
class AdminSetUserPasswordCommand extends Cmd {}
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand: class extends Cmd {}, RespondToAuthChallengeCommand: class extends Cmd {}, StartWebAuthnRegistrationCommand, CompleteWebAuthnRegistrationCommand, AdminSetUserPasswordCommand }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => mockRegistry() }, GetCommand: class extends Cmd {} }), { virtual: true });

import { ev, installDataApiFake, registryFake, cookieNamed, fakeAccessToken, RP, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
installDataApiFake();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/auth-lambda/index.js");
const run = (e: unknown) => handler(e) as Promise<Res>;
const json = (r: Res) => JSON.parse(r.body);
const lastInput = () => (mockSend.mock.calls.at(-1)![0] as Cmd).input as Record<string, unknown>;
const otpOk = { AuthenticationResult: { IdToken: "ID.TOK.EN", AccessToken: "AC.CESS.TOK" } };
const verify = (app: string, extra = {}) => ev("POST", app, "verify", { form: { session: "S", otp: "123456", email: "jo@acme.fr", return_url: "/dash" }, ...extra });

beforeEach(() => mockSend.mockReset());

describe("POST verify (OTP) → the passkey offer", () => {
  it("redirects to the offer with the AccessToken in a 5-minute HttpOnly cookie, plus the usual session cookie", async () => {
    mockSend.mockResolvedValueOnce(otpOk);
    const r = await run(verify("pk"));
    expect(r.statusCode).toBe(302);
    expect(r.headers?.Location).toBe("/auth/passkey/register?return_url=%2Fdash");
    expect(cookieNamed(r, "dilaya_id_token")).toContain("dilaya_id_token=ID.TOK.EN;");
    expect(cookieNamed(r, "dilaya_at")).toBe(`dilaya_at=AC.CESS.TOK; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=${RP}; Max-Age=300`);
    expect(cookieNamed(r, "dilaya_last_email")).toContain("jo%40acme.fr");
    expect(r.body).toBe("");
  });
  it("goes straight to return_url when this device already holds a passkey (dilaya_pk cookie)", async () => {
    mockSend.mockResolvedValueOnce(otpOk);
    const r = await run(verify("pk", { cookie: "dilaya_pk=1" }));
    expect(r.headers?.Location).toBe("/dash");
    expect(cookieNamed(r, "dilaya_at")).toBeNull();
  });
  it("goes straight to return_url off the rpId host, and for apps without passkeys (unchanged behaviour)", async () => {
    mockSend.mockResolvedValue(otpOk);
    expect((await run(verify("pk", { host: "pk-acme--stg.dilaya-apps.eu" }))).headers?.Location).toBe("/dash");
    expect((await run(verify("nopk"))).headers?.Location).toBe("/dash");
    expect((await run(verify("nopk", { host: null }))).headers?.Location).toBe("/dash");
    expect((await run(verify("nopk"))).cookies).toHaveLength(2); // session + last email
  });
});

describe("GET passkey/register", () => {
  it("renders the offer when the AccessToken cookie is present", async () => {
    const r = await run(ev("GET", "pk", "passkey/register", { cookie: "dilaya_at=AC.CESS.TOK", query: { return_url: "/dash" } }));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Enregistrer une passkey");
    expect(r.body).toContain('href="/dash"');
  });
  it("skips to return_url without the cookie (expired / already used) or off the rpId host", async () => {
    const r = await run(ev("GET", "pk", "passkey/register", { query: { return_url: "/dash" } }));
    expect(r.statusCode).toBe(302);
    expect(r.headers?.Location).toBe("/dash");
    expect((await run(ev("GET", "pk", "passkey/register", { host: "x.acme.fr", cookie: "dilaya_at=T" }))).statusCode).toBe(302);
  });
});

describe("POST passkey/register/start", () => {
  it("calls StartWebAuthnRegistration with the cookie's AccessToken and returns the creation options", async () => {
    const options = { rp: { id: RP }, challenge: "ch", user: { id: "u" } };
    mockSend.mockResolvedValueOnce({ CredentialCreationOptions: options });
    const r = await run(ev("POST", "pk", "passkey/register/start", { cookie: "dilaya_at=AC.CESS.TOK", json: {} }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ options });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(StartWebAuthnRegistrationCommand);
    expect(lastInput()).toEqual({ AccessToken: "AC.CESS.TOK" });
  });
  it("401 without the cookie; error JSON when Cognito refuses (e.g. WebAuthn not enabled)", async () => {
    const r = await run(ev("POST", "pk", "passkey/register/start", { json: {} }));
    expect(r.statusCode).toBe(401);
    expect(json(r)).toEqual({ error: "no_session" });
    expect(mockSend).not.toHaveBeenCalled();
    mockSend.mockRejectedValueOnce(Object.assign(new Error("WebAuthn not enabled for this pool."), { name: "WebAuthnNotEnabledException" }));
    const e = await run(ev("POST", "pk", "passkey/register/start", { cookie: "dilaya_at=T", json: {} }));
    expect(e.statusCode).toBe(200);
    expect(json(e)).toEqual({ error: "WebAuthnNotEnabledException" });
  });
});

describe("POST passkey/register/finish", () => {
  const credential = { id: "c1", rawId: "c1", type: "public-key", response: { attestationObject: "att", clientDataJSON: "cdj" } };
  const AT = fakeAccessToken("u-sub-1");
  it("completes the registration (credential as an OBJECT), then CONFIRMS the user, drops the AccessToken cookie, marks the device", async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const r = await run(ev("POST", "pk", "passkey/register/finish", { cookie: `dilaya_at=${AT}`, json: { credential } }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: true, confirmed: true });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CompleteWebAuthnRegistrationCommand);
    expect((mockSend.mock.calls[0][0] as Cmd).input).toEqual({ AccessToken: AT, Credential: credential });
    // Cognito offers the WEB_AUTHN challenge only to a CONFIRMED user; an
    // admin-created one is FORCE_CHANGE_PASSWORD until a permanent password is
    // set — a random one nobody knows (proven in prod, 2026-09-13).
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    const confirm = lastInput() as { UserPoolId: string; Username: string; Permanent: boolean; Password: string };
    expect(confirm.UserPoolId).toBe("eu-west-1_PK");
    expect(confirm.Username).toBe("u-sub-1");
    expect(confirm.Permanent).toBe(true);
    expect(confirm.Password.length).toBeGreaterThanOrEqual(24);
    expect(confirm.Password).toMatch(/[A-Z]/);
    expect(confirm.Password).toMatch(/[a-z]/);
    expect(confirm.Password).toMatch(/[0-9]/);
    expect(confirm.Password).toMatch(/[^A-Za-z0-9]/);
    expect(cookieNamed(r, "dilaya_at")).toContain("dilaya_at=; ");
    expect(cookieNamed(r, "dilaya_at")).toContain("Max-Age=0");
    expect(cookieNamed(r, "dilaya_pk")).toContain("dilaya_pk=1;");
  });
  it("registration ok but confirmation refused: still ok (the passkey exists), flagged confirmed:false", async () => {
    mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const r = await run(ev("POST", "pk", "passkey/register/finish", { cookie: `dilaya_at=${AT}`, json: { credential } }));
    expect(json(r)).toEqual({ ok: true, confirmed: false });
    expect(cookieNamed(r, "dilaya_pk")).toContain("dilaya_pk=1;");
  });
  it("reports the Cognito error name, keeps the session untouched; 401 without the cookie", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("dup"), { name: "WebAuthnCredentialNotSupportedException" }));
    const r = await run(ev("POST", "pk", "passkey/register/finish", { cookie: `dilaya_at=${AT}`, json: { credential } }));
    expect(json(r)).toEqual({ ok: false, error: "WebAuthnCredentialNotSupportedException" });
    expect(cookieNamed(r, "dilaya_pk")).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1); // no confirmation without a registered passkey
    expect((await run(ev("POST", "pk", "passkey/register/finish", { json: { credential } }))).statusCode).toBe(401);
    expect(json(await run(ev("POST", "pk", "passkey/register/finish", { cookie: "dilaya_at=T", json: {} })))).toEqual({ ok: false, error: "missing_credential" });
  });
});
