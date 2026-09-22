// OTP send throttle (t_quota_mail_bypass, audit 22/09). Every send-otp was a
// Postmark mail with no ceiling. Past 5 codes per address per 15 minutes no
// mail leaves — for a known address AND an unknown one, on the same page, or
// "too many codes" would tell a stranger which addresses are on the list.
const mockSend = jest.fn();
const counts = new Map<string, number>();
class Cmd { input: unknown; constructor(input: unknown) { this.input = input; } }
class UpdateCommand extends Cmd {}
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand: class extends Cmd {}, RespondToAuthChallengeCommand: class extends Cmd {}, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = async () => ({}) }, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => {
      const reg = mockRegistry();
      return {
        send: async (cmd: Cmd) => {
          if (!(cmd instanceof UpdateCommand)) return reg.send(cmd as never);
          const pk = (cmd.input as { Key: { pk: string } }).Key.pk;
          counts.set(pk, (counts.get(pk) ?? 0) + 1);
          return { Attributes: { n: counts.get(pk) } };
        },
      };
    },
  },
  GetCommand: class extends Cmd {},
  UpdateCommand,
}), { virtual: true });

import { ev, registryFake, authConfigResult, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }

// No Postmark token in SSM: nothing real is ever sent. A code SENT = one
// Cognito InitiateAuth (it mints the OTP the mail carries), so that is counted.
(global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { sql: string; app_id: string; params?: Array<{ value: { stringValue?: string } }> };
  const app = body.app_id.replace(/^app:/, "");
  const known = body.params?.[0]?.value?.stringValue === "jo@acme.fr";
  const json = body.sql.includes("_auth_config")
    ? authConfigResult(app)
    : { columnMetadata: [{ name: "1" }], records: known ? [[{ longValue: 1 }]] : [] };
  return { ok: true, status: 200, json: async () => json, text: async (): Promise<string> => "" };
});

process.env.APP_STATE_TABLE = "state";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/auth-lambda/index.js");
const run = (e: unknown) => handler(e) as Promise<Res>;
const send = (email: string) => run(ev("POST", "pk", "send-otp", { form: { email, return_url: "/x" } }));

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ Session: "S", ChallengeParameters: { otp: "123456" } });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("POST send-otp throttle", () => {
  it("sends at most 5 codes per address per window, then none", async () => {
    for (let i = 0; i < 7; i += 1) await send("jo@acme.fr");
    expect(mockSend).toHaveBeenCalledTimes(5); // no code minted — hence no mail — past the allowance
    const blocked = await send("jo@acme.fr");
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body).toMatch(/Trop de codes/);
  });

  it("an unknown address is throttled on the same page — no oracle", async () => {
    for (let i = 0; i < 6; i += 1) await send("nobody@acme.fr");
    const blocked = await send("nobody@acme.fr");
    expect(blocked.body).toMatch(/Trop de codes/);
  });

  it("another address is untouched", async () => {
    const ok = await send("JO2@acme.fr");
    expect(ok.body).not.toMatch(/Trop de codes/);
  });
});
