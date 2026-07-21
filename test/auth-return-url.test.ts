// safeReturnUrl — same-origin absolute return_url acceptance (t_b7d2e90a4c15).
// Relative paths pass through; an absolute http(s) URL on the CALLING host is
// normalized to path+query; everything else keeps the anti-open-redirect
// fallback. The AWS SDK modules are runtime-provided on Lambda — virtual-mock
// them so the module loads under jest (same preamble as auth-branding.test.ts).
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
const { safeReturnUrl } = __test__;

const ORG = "org-1";
const APP = "myapp";
const HOST = "www.cariaco.fr";
const SITE = `/o/${ORG}/${APP}/site`;

describe("safeReturnUrl — relative paths (unchanged)", () => {
  it("accepts a single-slash relative path, with or without a host", () => {
    expect(safeReturnUrl("/login?next=%2Fadmin", ORG, APP, HOST)).toBe("/login?next=%2Fadmin");
    expect(safeReturnUrl("/x", ORG, APP, null)).toBe("/x");
  });

  it("falls back on empty / protocol-relative", () => {
    expect(safeReturnUrl("", ORG, APP, HOST)).toBe("/");
    expect(safeReturnUrl(undefined, ORG, APP, null)).toBe(SITE);
    expect(safeReturnUrl("//evil.com/x", ORG, APP, HOST)).toBe("/");
  });
});

describe("safeReturnUrl — same-origin absolute URLs (new)", () => {
  it("accepts an absolute URL on the calling host, normalized to path+query", () => {
    expect(safeReturnUrl(`https://${HOST}/login?next=%2Fadmin%2Fusers`, ORG, APP, HOST)).toBe(
      "/login?next=%2Fadmin%2Fusers"
    );
    expect(safeReturnUrl(`https://${HOST}/`, ORG, APP, HOST)).toBe("/");
  });

  it("host comparison is case-insensitive and drops the fragment", () => {
    expect(safeReturnUrl(`https://WWW.CARIACO.FR/x?a=1#frag`, ORG, APP, HOST)).toBe("/x?a=1");
  });

  it("rejects the same URL on ANOTHER host (fallback)", () => {
    expect(safeReturnUrl(`https://${HOST}/login`, ORG, APP, "other--org.dilaya-apps.eu")).toBe("/");
  });

  it("rejects foreign hosts, schemes and malformed values", () => {
    expect(safeReturnUrl("https://evil.com/x", ORG, APP, HOST)).toBe("/");
    expect(safeReturnUrl("javascript:alert(1)", ORG, APP, HOST)).toBe("/");
    expect(safeReturnUrl("ftp://" + HOST + "/x", ORG, APP, HOST)).toBe("/");
    expect(safeReturnUrl("not a url", ORG, APP, HOST)).toBe("/");
  });

  it("rejects a same-host URL whose path is protocol-relative-shaped", () => {
    expect(safeReturnUrl(`https://${HOST}//evil.com/x`, ORG, APP, HOST)).toBe("/");
  });

  it("path-URL flow (no app host): absolute URLs keep the /site fallback", () => {
    expect(safeReturnUrl("https://app.dilaya.eu/x", ORG, APP, null)).toBe(SITE);
  });
});
