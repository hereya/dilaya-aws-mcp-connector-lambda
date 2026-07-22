// Origin lock path coverage — the frontend authorizer's SITE_OR_AUTH_RE must
// cover EVERY tenant-content path family (production site, STAGING site-stg,
// auth tree). /site-stg was missed when staging shipped (0.1.30): `site`
// followed by `-` failed the `(?:\/|$)` tail, so staging frontends kept
// answering on the first-party path URL (t_9d622bd2255b).
// The AWS SDK modules are runtime-provided on Lambda and absent from
// devDependencies — virtual-mock them so the module loads under jest.
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterHistoryCommand: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/frontend-authorizer/index.js");
const { SITE_OR_AUTH_RE } = __test__;

describe("SITE_OR_AUTH_RE (origin lock scope)", () => {
  const locked = [
    "/o/org1/app1/site",
    "/o/org1/app1/site/",
    "/o/org1/app1/site/page",
    "/o/org1/app1/site-stg",
    "/o/org1/app1/site-stg/",
    "/o/org1/app1/site-stg/page",
    "/o/org1/app1/auth",
    "/o/org1/app1/auth/login",
    "/o/43a70df3-c9d9-41a0-b893-ad706143b196/komlaba/auth/send-otp",
  ];
  it.each(locked)("locks %s", (p) => {
    expect(SITE_OR_AUTH_RE.test(p)).toBe(true);
  });

  const open = [
    "/mcp",
    "/o/org1/app1/agent/poll",
    "/o/org1/app1/telegram/webhook",
    "/o/org1/app1/secrets/setup",
    "/o/org1/app1/mcp/call",
    "/o/org1/app1/cron/list",
    "/o/org1/app1/llm/complete",
    // Not a real route family, but must not accidentally match either:
    "/o/org1/app1/site-other",
    "/o/org1/app1/authx",
  ];
  it.each(open)("leaves %s alone", (p) => {
    expect(SITE_OR_AUTH_RE.test(p)).toBe(false);
  });
});
