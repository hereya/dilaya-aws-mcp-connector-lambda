// t_otp_resend_race (19/10): "Resend code" minted a NEW code and overwrote the
// one already in the inbox — a slow first mail arriving after the second
// carried a dead code. The create-auth-challenge trigger now reuses a code
// still in force, so every mail of a sign-in episode carries the same code.
const store = new Map<string, Record<string, unknown>>();
class Cmd { input: Record<string, any>; constructor(input: Record<string, any>) { this.input = input; } }
class GetCommand extends Cmd {}
class PutCommand extends Cmd {}
class UpdateCommand extends Cmd {}
const keyOf = (k: { pool_id: string; email: string }) => `${k.pool_id}|${k.email}`;
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Cmd) => {
        if (cmd instanceof GetCommand) return { Item: store.get(keyOf(cmd.input.Key)) };
        if (cmd instanceof PutCommand) { store.set(keyOf(cmd.input.Item), { ...cmd.input.Item }); return {}; }
        if (cmd instanceof UpdateCommand) {
          const item = store.get(keyOf(cmd.input.Key));
          if (!item || item.otp !== cmd.input.ExpressionAttributeValues[":otp"]) {
            throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
          }
          item.ttl = cmd.input.ExpressionAttributeValues[":ttl"];
          return {};
        }
        throw new Error("unexpected command");
      },
    }),
  },
  GetCommand,
  PutCommand,
  UpdateCommand,
}), { virtual: true });

process.env.OTP_TABLE_NAME = "otp";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/cognito-triggers/create-auth-challenge/index.js");

const POOL = "eu-west-1_P";
const EMAIL = "jo@acme.fr";
const challenge = async () => {
  const res = await handler({ userPoolId: POOL, request: { userAttributes: { email: EMAIL } }, response: {} });
  return res.response.privateChallengeParameters.answer as string; // never public (otp-not-public.test.ts)
};
const record = () => store.get(`${POOL}|${EMAIL}`)!;
let now = 1_800_000_000_000;

beforeEach(() => {
  store.clear();
  now = 1_800_000_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("create-auth-challenge reuses a code still in force", () => {
  it("a resend carries the SAME code, so the first mail still works", async () => {
    const first = await challenge();
    now += 60_000;
    expect(await challenge()).toBe(first);
    expect(record().otp).toBe(first);
  });

  it("a resend gives the code a full window from now, never past 15 min from its issue", async () => {
    await challenge();
    const issued = record().issuedAt as number;
    now += 240_000; // 4 min: 1 min left
    await challenge();
    expect(record().ttl).toBe(issued + 240 + 300);
    now += 240_000; // 8 min: in force until 13 min
    await challenge();
    now += 240_000; // 12 min: a full window would reach 17 min
    await challenge();
    expect(record().ttl).toBe(issued + 15 * 60);
  });

  it("keeps the wrong-attempt counter — a resend hands a guesser no fresh tries", async () => {
    const first = await challenge();
    record().attempts = 2;
    expect(await challenge()).toBe(first);
    expect(record().attempts).toBe(2);
  });

  it("mints a new code once the old one expired", async () => {
    const first = await challenge();
    now += 301_000;
    const second = await challenge();
    expect(second).not.toBe(first);
    expect(record()).toMatchObject({ otp: second, attempts: 0 });
  });

  it("mints a new code after 3 wrong attempts", async () => {
    const first = await challenge();
    record().attempts = 3;
    expect(await challenge()).not.toBe(first);
  });

  it("mints a new code past the episode bound, however often it was resent", async () => {
    const first = await challenge();
    for (let i = 0; i < 4; i += 1) { now += 200_000; expect(await challenge()).toBe(first); }
    now += 200_000; // 16 min 40 s after issue
    expect(await challenge()).not.toBe(first);
  });

  it("a record written before the change (no issuedAt) is reused on its createdAt", async () => {
    store.set(`${POOL}|${EMAIL}`, { pool_id: POOL, email: EMAIL, otp: "424242", attempts: 0, ttl: now / 1000 + 200, createdAt: new Date(now - 100_000).toISOString() });
    expect(await challenge()).toBe("424242");
  });
});
