// t_cognito_write_attrs (26/10): the app keys its users on the ID token's
// `email`. A pool user can change that attribute (UpdateUserAttributes with
// their own access token) to an address they do not own; Cognito then marks it
// `email_verified: false` and the NEXT ID token carries the new address. The
// authorizer refuses an ID token whose e-mail is not verified, so an unproven
// address never becomes an app identity. Every user Dilaya creates is born
// verified (AdminCreateUser email_verified=true), and a successful login code
// re-verifies — so an honest user always carries `email_verified: true`.
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
};

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  });
});

describe("frontend authorizer: only a verified e-mail is an identity", () => {
  const cfg = { userPoolId: POOL, userPoolClientId: CLIENT };

  it("accepts email_verified true (Cognito's boolean) and \"true\" (string form)", async () => {
    expect(await t.verifyCognitoIdToken(sign({ ...base, email_verified: true }), cfg)).not.toBeNull();
    expect(await t.verifyCognitoIdToken(sign({ ...base, email_verified: "true" }), cfg)).not.toBeNull();
  });

  it("refuses an unverified e-mail — the state UpdateUserAttributes leaves behind", async () => {
    expect(await t.verifyCognitoIdToken(sign({ ...base, email_verified: false }), cfg)).toBeNull();
    expect(await t.verifyCognitoIdToken(sign({ ...base, email_verified: "false" }), cfg)).toBeNull();
  });

  it("refuses a token that does not say", async () => {
    expect(await t.verifyCognitoIdToken(sign(base), cfg)).toBeNull();
  });
});
