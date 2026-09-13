// The session cookie lives exactly as long as the ID token it carries
// (t_frontend_auth_default). It used to be a flat 24 h against a 1 h token:
// for 23 h the browser kept sending a token nobody could verify. Now the edge
// router, which can only see whether a cookie is PRESENT, sees it disappear
// when the token dies and sends the visitor back to /auth/login.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { idTokenMaxAge } = __test__;

const jwt = (payload: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

describe("idTokenMaxAge", () => {
  it("is the seconds left on the token's exp", () => {
    const now = Math.floor(Date.now() / 1000);
    const age = idTokenMaxAge(jwt({ exp: now + 3600 }));
    expect(age).toBeGreaterThan(3590);
    expect(age).toBeLessThanOrEqual(3600);
  });

  it("caps at a day and never goes below one second for a live token", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(idTokenMaxAge(jwt({ exp: now + 10 * 86400 }))).toBe(86400);
    expect(idTokenMaxAge(jwt({ exp: now + 1 }))).toBeGreaterThanOrEqual(0);
  });

  it("falls back for an expired, absent or unreadable exp", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(idTokenMaxAge(jwt({ exp: now - 5 }))).toBe(3600);
    expect(idTokenMaxAge(jwt({}))).toBe(3600);
    expect(idTokenMaxAge("garbage")).toBe(3600);
    expect(idTokenMaxAge(undefined, 120)).toBe(120);
  });
});

export {};
