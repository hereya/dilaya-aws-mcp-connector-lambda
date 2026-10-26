// t_cognito_write_attrs (26/10): the login code must NEVER reach whoever calls
// InitiateAuth. Cognito returns a create-auth-challenge trigger's
// `publicChallengeParameters` to the CALLER as `ChallengeParameters`, and the
// per-app clients are public (no secret; the client id is the `aud` of every
// ID token a signed-in user holds). With the code in there, anyone holding an
// app's client id could call InitiateAuth(CUSTOM_AUTH, USERNAME=<victim>)
// straight against Cognito, read the code from the answer and sign in as any
// user of that app. The trigger now keeps the code private (DynamoDB +
// privateChallengeParameters) and the auth Lambda reads it from the table.
const store = new Map<string, Record<string, unknown>>();
const otpReads: Array<Record<string, unknown>> = [];
const mails: string[] = [];
const mockSend = jest.fn();
class Cmd { input: Record<string, any>; constructor(input: Record<string, any>) { this.input = input; } }
class GetCommand extends Cmd {}
class PutCommand extends Cmd {}
class UpdateCommand extends Cmd {}
const keyOf = (k: { pool_id: string; email: string }) => `${k.pool_id}|${k.email}`;
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand: class extends Cmd {}, RespondToAuthChallengeCommand: class extends Cmd {}, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = async () => ({ Parameter: { Value: "server-token" } }) }, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Cmd) => {
        if (cmd.input.TableName === "otp") {
          if (cmd instanceof GetCommand) { otpReads.push(cmd.input); return { Item: store.get(keyOf(cmd.input.Key)) }; }
          if (cmd instanceof PutCommand) { store.set(keyOf(cmd.input.Item), { ...cmd.input.Item }); return {}; }
          return {};
        }
        if (cmd instanceof UpdateCommand) return { Attributes: { n: 1 } };
        return mockRegistry().send(cmd as never);
      },
    }),
  },
  GetCommand,
  PutCommand,
  UpdateCommand,
}), { virtual: true });
jest.mock("https", () => ({
  request: (_opts: unknown, cb: (res: unknown) => void) => {
    let payload = "";
    return {
      on: () => undefined,
      write: (p: string) => { payload += p; },
      end: () => {
        mails.push(payload);
        const handlers: Record<string, (d?: string) => void> = {};
        cb({ statusCode: 200, on: (e: string, h: (d?: string) => void) => { handlers[e] = h; } });
        handlers.data?.(JSON.stringify({ ErrorCode: 0, Message: "OK" }));
        handlers.end?.();
      },
    };
  },
}));

process.env.OTP_TABLE_NAME = "otp";
process.env.APP_STATE_TABLE = "state";
import { ev, registryFake, installDataApiFake, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
installDataApiFake();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const trigger = require("../lib/cognito-triggers/create-auth-challenge/index.js").handler;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/auth-lambda/index.js");

const POOL = "eu-west-1_PK"; // the `pk` app's pool in the shared harness
const EMAIL = "Jo@Acme.fr";

beforeEach(() => {
  store.clear();
  otpReads.length = 0;
  mails.length = 0;
  mockSend.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("create-auth-challenge keeps the code private", () => {
  it("publishes no code to the caller — only the table key", async () => {
    const res = await trigger({ userPoolId: POOL, request: { userAttributes: { email: EMAIL } }, response: {} });
    const stored = store.get(`${POOL}|${EMAIL}`)!;
    expect(stored.otp).toMatch(/^\d{6}$/);
    expect(res.response.privateChallengeParameters).toEqual({ answer: stored.otp });
    expect(res.response.publicChallengeParameters).toEqual({ k: EMAIL });
    expect(JSON.stringify(res.response.publicChallengeParameters)).not.toContain(String(stored.otp));
  });
});

describe("auth Lambda mails the code it reads from the OTP table", () => {
  const sendOtp = () =>
    handler(ev("POST", "pk", "send-otp", { form: { email: "jo@acme.fr", return_url: "/x" } })) as Promise<Res>;

  it("reads (pool, canonical e-mail) consistently and mails that code", async () => {
    store.set(`${POOL}|${EMAIL}`, { pool_id: POOL, email: EMAIL, otp: "654321" });
    mockSend.mockResolvedValueOnce({ Session: "S", ChallengeParameters: { k: EMAIL } });
    const res = await sendOtp();
    expect(res.statusCode).toBe(200);
    expect(otpReads).toEqual([{ TableName: "otp", Key: { pool_id: POOL, email: EMAIL }, ConsistentRead: true }]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toContain("654321");
  });

  it("an old trigger still carrying the code keeps working during the rollout", async () => {
    mockSend.mockResolvedValueOnce({ Session: "S", ChallengeParameters: { otp: "111222" } });
    await sendOtp();
    expect(otpReads).toEqual([]);
    expect(mails[0]).toContain("111222");
  });

  it("no record → no mail, the same page (nothing to leak, nothing to crash)", async () => {
    mockSend.mockResolvedValueOnce({ Session: "S", ChallengeParameters: { k: EMAIL } });
    const res = await sendOtp();
    expect(res.statusCode).toBe(200);
    expect(mails).toEqual([]);
  });
});
