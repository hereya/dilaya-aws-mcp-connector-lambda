// Data API retry — the two EDGE lambdas (frontend-authorizer + auth-lambda) hold
// their OWN Data API client, separate from the connector's. Until 2026-07-30 they
// gave up on the first attempt, so a few-second VM bounce (503 `UNAVAILABLE:
// instance is shutting down; retry shortly`) read as "this app has no auth
// config": a logged-in visitor was served as anonymous and bounced to
// /auth/login, and the login page itself couldn't work either. The connector saw
// 0 errors through the same bounce because its client retries. These tests pin
// that behaviour on both edge copies.
//
// The AWS SDK modules are runtime-provided on Lambda and absent from
// devDependencies — virtual-mock them so the modules load under jest.
process.env.dataApiUrl = "https://data-api.test";
process.env.registryTableName = "registry-test";
process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
process.env.AWS_SECRET_ACCESS_KEY = "secret-test";

jest.mock(
  "@aws-sdk/client-cognito-identity-provider",
  () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {} }),
  { virtual: true }
);
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/client-ssm",
  () => ({ SSMClient: class {}, GetParameterCommand: class {}, GetParameterHistoryCommand: class {} }),
  { virtual: true }
);
jest.mock(
  "@aws-sdk/client-secrets-manager",
  () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }),
  { virtual: true }
);
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizer = require("../lib/frontend-authorizer/index.js").__test__;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authLambda = require("../lib/auth-lambda/index.js").__test__;

type Attempt = { status: number; body?: string } | { throws: string };

/** Stub global fetch with a scripted sequence; returns the call counter. */
function scriptFetch(attempts: Attempt[]): { calls: () => number } {
  let i = 0;
  (globalThis as any).fetch = async () => {
    const step = attempts[Math.min(i, attempts.length - 1)];
    i++;
    if ("throws" in step) throw new Error(step.throws);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => step.body ?? "",
      json: async () => JSON.parse(step.body ?? "{}"),
    };
  };
  return { calls: () => i };
}

const realFetch = (globalThis as any).fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

const UNAVAILABLE = '{"code":"UNAVAILABLE","message":"instance is shutting down; retry shortly"}';
const OK_BODY = '{"records":[[{"stringValue":"eu-west-1_pool"}]]}';

for (const [name, mod] of [
  ["frontend-authorizer", authorizer],
  ["auth-lambda", authLambda],
] as const) {
  describe(`${name}: dataApiQuery retries`, () => {
    it("retries the VM's transient 503 and returns the result", async () => {
      const f = scriptFetch([{ status: 503, body: UNAVAILABLE }, { status: 200, body: OK_BODY }]);
      const res = await mod.dataApiQuery("org-1", "app-1", "SELECT 1");
      expect(res).toEqual({ records: [[{ stringValue: "eu-west-1_pool" }]] });
      expect(f.calls()).toBe(2);
    });

    it("retries a network blip while the VM cycles", async () => {
      const f = scriptFetch([{ throws: "fetch failed" }, { status: 200, body: OK_BODY }]);
      await mod.dataApiQuery("org-1", "app-1", "SELECT 1");
      expect(f.calls()).toBe(2);
    });

    it("gives up after a bounded number of attempts (no infinite loop)", async () => {
      const f = scriptFetch([{ status: 503, body: UNAVAILABLE }]);
      await expect(mod.dataApiQuery("org-1", "app-1", "SELECT 1")).rejects.toThrow("data API /query 503");
      expect(f.calls()).toBe(mod.DATA_API_RETRIES + 1);
    });

    it("does NOT retry a non-transient error — a bad statement fails at once", async () => {
      const f = scriptFetch([{ status: 400, body: '{"error":{"code":"SQL_ERROR"}}' }]);
      await expect(mod.dataApiQuery("org-1", "app-1", "SELECT nope")).rejects.toThrow("data API /query 400");
      expect(f.calls()).toBe(1);
    });

    it("does NOT retry a capability denial (403) — retrying can't fix authorization", async () => {
      const f = scriptFetch([{ status: 403, body: '{"code":"CAPABILITY_DENIED"}' }]);
      await expect(mod.dataApiQuery("org-1", "app-1", "SELECT 1")).rejects.toThrow("data API /query 403");
      expect(f.calls()).toBe(1);
    });

    it("treats the same states as transient as the connector's own client", () => {
      expect([...mod.RETRYABLE_STATUS].sort()).toEqual([429, 502, 503, 504]);
    });
  });
}
