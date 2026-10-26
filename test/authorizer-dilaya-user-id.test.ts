// Stable Dilaya user id (t_rca_p0_userid, Région Canada P0c). The frontend
// authorizer verifies the app's Cognito ID token and hands the app its identity
// through the authorizer context. `cognito_sub` is pool-local: a pool migration
// (EU → Canada) changes it. The context therefore also carries
// `dilaya_user_id` = the verified `custom:dilaya_uid` claim, else `sub` — equal
// to `cognito_sub` for every user of today's pools (none declares the attribute).
process.env.COGNITO_REGION = "eu-west-1";
process.env.dataApiUrl = "https://data-api.test";
process.env.registryTableName = "registry-test";

import * as crypto from "crypto";

jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }),
  { virtual: true }
);
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const t = require("../lib/frontend-authorizer/index.js").__test__;

const POOL = "eu-west-1_TESTPOOL";
const CLIENT = "client-123";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function sign(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}
const base = {
  iss: `https://cognito-idp.eu-west-1.amazonaws.com/${POOL}`,
  aud: CLIENT,
  token_use: "id",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "ana@example.com",
  sub: "sub-eu-1111",
  email_verified: true,
};

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  });
});

describe("frontend authorizer: stable dilaya_user_id", () => {
  const cfg = { userPoolId: POOL, userPoolClientId: CLIENT };

  it("falls back to sub when the pool carries no custom:dilaya_uid (every pool today)", async () => {
    const id = await t.verifyCognitoIdToken(sign(base), cfg);
    expect(id).toEqual({ email: "ana@example.com", sub: "sub-eu-1111", dilayaUserId: "sub-eu-1111" });
    expect(t.humanContext(id)).toEqual({
      email: "ana@example.com",
      cognito_sub: "sub-eu-1111",
      dilaya_user_id: "sub-eu-1111",
      authenticated: "true",
      agent: "false",
      public: "false",
    });
  });

  it("keeps the verified custom:dilaya_uid across a pool migration; cognito_sub unchanged", async () => {
    const migrated = { ...base, sub: "sub-ca-2222", "custom:dilaya_uid": "sub-eu-1111" };
    const id = await t.verifyCognitoIdToken(sign(migrated), cfg);
    const ctx = t.humanContext(id);
    expect(ctx.cognito_sub).toBe("sub-ca-2222");
    expect(ctx.dilaya_user_id).toBe("sub-eu-1111");
  });

  it("ignores an empty or non-string custom:dilaya_uid", () => {
    expect(t.cognitoIdentity({ ...base, "custom:dilaya_uid": "" }).dilayaUserId).toBe("sub-eu-1111");
    expect(t.cognitoIdentity({ ...base, "custom:dilaya_uid": 42 }).dilayaUserId).toBe("sub-eu-1111");
  });

  it("never trusts a claim from a token whose signature does not verify", async () => {
    const good = sign(base).split(".");
    const forged = b64u(JSON.stringify({ ...base, "custom:dilaya_uid": "victim" }));
    expect(await t.verifyCognitoIdToken(`${good[0]}.${forged}.${good[2]}`, cfg)).toBeNull();
  });
});
