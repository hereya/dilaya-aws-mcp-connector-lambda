// HEAD on the auth pages (t_head_404_tenant_sites): the router only knew
// GET/POST, so `HEAD /auth/login` answered 404 while the same GET answered 200 —
// an uptime monitor or link checker (HEAD by default) saw a live login page as down.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {}, StartWebAuthnRegistrationCommand: class {}, CompleteWebAuthnRegistrationCommand: class {}, AdminSetUserPasswordCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { routeMethod } = __test__;

describe("routeMethod — HEAD routes like the GET it mirrors", () => {
  it("HEAD on a page is routed as GET", () => {
    expect(routeMethod("HEAD", "login")).toBe("GET");
    expect(routeMethod("HEAD", "passkey/register")).toBe("GET");
  });
  it("HEAD on logout stays HEAD: a safe method must not clear the session", () => {
    expect(routeMethod("HEAD", "logout")).toBe("HEAD");
  });
  it("every other method is untouched", () => {
    expect(routeMethod("GET", "login")).toBe("GET");
    expect(routeMethod("POST", "verify")).toBe("POST");
  });
});
