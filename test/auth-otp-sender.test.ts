// Login-code sender (t_app_login_first_code, 07/10). A brand-new per-app sender
// domain made iCloud defer the FIRST code ~3 min (laberis: accepted 14:02:14,
// delivered 14:05:34; the resend 14 s). Codes of an app on the content domain
// now leave from ONE warmed address under the app's name; a custom-domain
// sender is untouched; a refused shared send falls back to the app's own.
const mockSend = jest.fn();
const sentFroms: string[] = [];
let refuseShared = false;
class Cmd { input: unknown; constructor(input: unknown) { this.input = input; } }
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand: class extends Cmd {}, RespondToAuthChallengeCommand: class extends Cmd {}, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = async () => ({ Parameter: { Value: "server-token" } }) }, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => {
    const reg = mockRegistry();
    return { send: async (cmd: Cmd) => (cmd instanceof mockUpdate ? { Attributes: { n: 1 } } : reg.send(cmd as never)) };
  } },
  GetCommand: class extends Cmd {},
  UpdateCommand: class extends Cmd {},
}), { virtual: true });
jest.mock("https", () => ({
  request: (_opts: unknown, cb: (res: unknown) => void) => {
    let payload = "";
    return {
      on: () => undefined,
      write: (p: string) => { payload += p; },
      end: () => {
        const from = (JSON.parse(payload) as { From: string }).From;
        sentFroms.push(from);
        const refused = refuseShared && from.includes("noreply@dilaya-apps.eu");
        const body = refused ? { ErrorCode: 400, Message: "not a Sender Signature" } : { ErrorCode: 0, Message: "OK" };
        const handlers: Record<string, (d?: string) => void> = {};
        cb({ statusCode: refused ? 422 : 200, on: (e: string, h: (d?: string) => void) => { handlers[e] = h; } });
        handlers.data?.(JSON.stringify(body));
        handlers.end?.();
      },
    };
  },
}));

process.env.OTP_SENDER_DOMAIN = "dilaya-apps.eu";
process.env.APP_STATE_TABLE = "state";
import { ev, registryFake, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockUpdate = require("@aws-sdk/lib-dynamodb").UpdateCommand;

const rows: Record<string, Record<string, unknown>> = {
  laberis: { user_pool_client_id: "c1", from_email: "noreply@laberis-demo.dilaya-apps.eu" },
  titled: { user_pool_client_id: "c2", from_email: "noreply@titled-demo.dilaya-apps.eu", login_title: "Espace \"Club\"" },
  byod: { user_pool_client_id: "c3", from_email: "noreply@acme.fr" },
};
(global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { sql: string; app_id: string };
  const row = rows[body.app_id.replace(/^app:/, "")];
  const json = body.sql.includes("_auth_config") && row
    ? { columnMetadata: Object.keys(row).map((name) => ({ name })), records: [Object.values(row).map((v) => ({ stringValue: String(v) }))] }
    : { columnMetadata: [{ name: "1" }], records: [[{ longValue: 1 }]] };
  return { ok: true, status: 200, json: async () => json, text: async (): Promise<string> => "" };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, __test__ } = require("../lib/auth-lambda/index.js");
const sendOtp = (app: string) =>
  handler(ev("POST", app, "send-otp", { form: { email: "jo@acme.fr", return_url: "/x" } })) as Promise<Res>;

beforeEach(() => {
  sentFroms.length = 0;
  refuseShared = false;
  mockSend.mockReset();
  mockSend.mockResolvedValue({ Session: "S", ChallengeParameters: { otp: "123456" } });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("login-code sender", () => {
  it("an app on the content domain sends from the shared address, under its name", async () => {
    await sendOtp("laberis");
    expect(sentFroms).toEqual(['"Laberis" <noreply@dilaya-apps.eu>']);
  });

  it("the login title names the sender, stripped of header-breaking characters", async () => {
    await sendOtp("titled");
    expect(sentFroms).toEqual(['"Espace Club" <noreply@dilaya-apps.eu>']);
  });

  it("a custom-domain sender is kept", async () => {
    await sendOtp("byod");
    expect(sentFroms).toEqual(["noreply@acme.fr"]);
  });

  it("a refused shared send falls back to the app's own address, and says so", async () => {
    refuseShared = true;
    await sendOtp("laberis");
    expect(sentFroms).toEqual(['"Laberis" <noreply@dilaya-apps.eu>', "noreply@laberis-demo.dilaya-apps.eu"]);
    const logged = (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/"type":"otp_send_failed".*"errorCode":400/);
  });

  it("pure helpers: a non-content sender is kept, an over-long title falls back to the app name", () => {
    expect(__test__.otpFromCandidates("noreply@acme.fr", "a", {})).toEqual(["noreply@acme.fr"]);
    expect(__test__.senderDisplayName("inventaire", { loginTitle: "x".repeat(41) })).toBe("Inventaire");
  });
});
