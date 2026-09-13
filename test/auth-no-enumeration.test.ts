// No address enumeration on the login page (t_login_enumeration, 13/09/2026).
//
// Jonatan's screenshot: sotracodel's login answering « No account found for
// this email » to his own address — a different page for an unknown address
// than for a known one, i.e. an oracle over a customer's user list. Every
// address now gets the same code page; the unknown one carries a DECOY session
// that verify recognises and answers "incorrect code" to, like a wrong code on
// a real session. Cognito is mocked; the Data API + registry are faked.
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

import { ev, registryFake, authConfigResult, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }

// The allowlist: only jo@acme.fr is in — every other address is unknown.
(global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { sql: string; app_id: string; params?: Array<{ value: { stringValue?: string } }> };
  const app = body.app_id.replace(/^app:/, "");
  const known = body.params?.[0]?.value?.stringValue === "jo@acme.fr";
  const json = body.sql.includes("_auth_config")
    ? authConfigResult(app)
    : { columnMetadata: [{ name: "1" }], records: known ? [[{ longValue: 1 }]] : [] };
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, __test__ } = require("../lib/auth-lambda/index.js");
const run = (e: unknown) => handler(e) as Promise<Res>;
const sessionOf = (r: Res) => /name="session" value="([^"]*)"/.exec(r.body)?.[1] ?? "";
const strip = (r: Res, email: string) =>
  r.body.split(sessionOf(r)).join("SESSION").split(email).join("E").split(encodeURIComponent(email)).join("E");

beforeEach(() => {
  mockSend.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("POST send-otp", () => {
  it("answers a known and an unknown address with the SAME page — only the session differs", async () => {
    mockSend.mockResolvedValueOnce({ Session: "COGNITO-S1", ChallengeParameters: { otp: "123456" } });
    const known = await run(ev("POST", "pk", "send-otp", { form: { email: "jo@acme.fr", return_url: "/x" } }));
    const unknown = await run(ev("POST", "pk", "send-otp", { form: { email: "nobody@acme.fr", return_url: "/x" } }));
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(sessionOf(known)).toBe("COGNITO-S1");
    expect(await __test__.isDecoySession(sessionOf(unknown))).toBe(true);
    // Same page, the e-mail aside.
    expect(strip(unknown, "nobody@acme.fr")).toBe(strip(known, "jo@acme.fr"));
    for (const r of [known, unknown]) {
      expect(r.body).not.toMatch(/No account|Aucun compte/);
      expect(r.body).toContain('name="otp"');
    }
    // The unknown address never reached Cognito.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("an address Cognito itself refuses gets the same decoy page", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "UserNotFoundException" }));
    const r = await run(ev("POST", "pk", "send-otp", { form: { email: "jo@acme.fr" } }));
    expect(r.statusCode).toBe(200);
    expect(await __test__.isDecoySession(sessionOf(r))).toBe(true);
    expect(r.body).not.toMatch(/No account|Aucun compte/);
  });

  it("an app without login says nothing either", async () => {
    const r = await run(ev("POST", "ghost", "send-otp", { form: { email: "jo@acme.fr" } }));
    expect(r.statusCode).toBe(200);
    expect(await __test__.isDecoySession(sessionOf(r))).toBe(true);
  });
});

describe("POST verify with a decoy session", () => {
  it("answers exactly like a wrong code on a real session, without asking Cognito", async () => {
    const decoy = await __test__.decoySession();
    const r = await run(ev("POST", "pk", "verify", { form: { session: decoy, otp: "000000", email: "nobody@acme.fr" } }));
    mockSend.mockResolvedValueOnce({ Session: "COGNITO-S2" });
    const real = await run(ev("POST", "pk", "verify", { form: { session: "COGNITO-S1", otp: "000000", email: "jo@acme.fr" } }));
    expect(r.statusCode).toBe(200);
    expect(real.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(strip(r, "nobody@acme.fr")).toBe(strip(real, "jo@acme.fr"));
    expect(r.body).toMatch(/Code incorrect|Incorrect code/);
  });
});

describe("decoy sessions", () => {
  it("look like an opaque session, verify under the same key, and never by accident", async () => {
    const d = await __test__.decoySession();
    expect(d).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(d.length).toBeGreaterThan(700);
    expect(await __test__.isDecoySession(d)).toBe(true);
    expect(await __test__.isDecoySession(d.slice(0, -4) + "AAAA")).toBe(false);
    expect(await __test__.isDecoySession("COGNITO-S1")).toBe(false);
    expect(await __test__.isDecoySession("")).toBe(false);
    expect(await __test__.isDecoySession(undefined)).toBe(false);
  });
});

describe("POST passkey/start", () => {
  it("an address off the allowlist answers like one without a passkey", async () => {
    mockSend.mockResolvedValueOnce({ ChallengeName: "EMAIL_OTP", Session: "S" });
    const off = JSON.parse((await run(ev("POST", "pk", "passkey/start", { json: { email: "nobody@acme.fr" } }))).body);
    const noPk = JSON.parse((await run(ev("POST", "pk", "passkey/start", { json: { email: "jo@acme.fr" } }))).body);
    expect(off).toEqual({ fallback: "no_passkey" });
    expect(noPk).toEqual({ fallback: "no_passkey" });
  });
});
