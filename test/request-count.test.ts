// Per-app request counting — the consumption dimension that did not exist.
//
// Until 2026-08-28 an organization's consumption was measured in megabytes,
// files and emails; NOTHING counted requests. That blind spot has a date: on
// 2026-08-27 one looping browser called a single tenant route 17 386 times in
// under two hours — ~70 % of the connector's traffic for the day — and every
// request answered 200, so no error metric, no 5xx and none of the account's
// 32 alarms could see it. The org's usage report for that day would have read
// perfectly normal.
//
// These tests hold the three properties that make the counter safe to run on
// the hottest path in the platform: it counts every attributed request
// whatever the auth outcome, it is keyed so that requests stay separable per
// app and per month, and it can NEVER cost a request its answer.

// The AWS SDK modules are runtime-provided on Lambda and absent from
// devDependencies — virtual-mock them so the module loads under jest.
const sends: any[] = [];
let sendImpl: (cmd: any) => Promise<any> = async () => ({});

jest.mock(
  "@aws-sdk/client-secrets-manager",
  () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }),
  { virtual: true }
);
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), {
  virtual: true,
});
jest.mock(
  "@aws-sdk/client-ssm",
  () => ({ SSMClient: class {}, GetParameterHistoryCommand: class {} }),
  { virtual: true }
);
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({
    DynamoDBDocumentClient: {
      from: () => ({
        send: (cmd: any) => {
          sends.push(cmd);
          return sendImpl(cmd);
        },
      }),
    },
    GetCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
        (this as any).__kind = "Get";
      }
    },
    UpdateCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
        (this as any).__kind = "Update";
      }
    },
  }),
  { virtual: true }
);

process.env.APP_STATE_TABLE = "test-app-state";
// Origin lock off, so a plain site request is not denied before it is counted.
delete process.env.appContentDomain;
delete process.env.APP_CONTENT_DOMAIN;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizer = require("../lib/frontend-authorizer/index.js");

const updates = () => sends.filter((c) => c.__kind === "Update");

function siteEvent(path: string) {
  return { rawPath: path, headers: {}, requestContext: { http: { path } } };
}

const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";

describe("frontend authorizer request counting", () => {
  beforeEach(() => {
    sends.length = 0;
    sendImpl = async () => ({});
  });

  test("an anonymous site request is counted — it cost the same invocation as any other", async () => {
    // No registry table configured, so the app never resolves and the request
    // comes back ANON. That is precisely the population an appId-keyed counter
    // would have dropped: an app with auth not enabled still burns a Lambda.
    const res = await authorizer.handler(siteEvent(`/o/${ORG}/cariacomenu/site/api/auth/me`));
    expect(res.isAuthorized).toBe(true);
    expect(updates()).toHaveLength(1);
  });

  test("the key separates org, app and month, so one app's loop is attributable", async () => {
    await authorizer.handler(siteEvent(`/o/${ORG}/cariacomenu/site/api/auth/me`));
    const { input } = updates()[0];
    const month = new Date().toISOString().slice(0, 7);
    expect(input.TableName).toBe("test-app-state");
    expect(input.Key.pk).toBe(`reqcount#${ORG}#cariacomenu#${month}`);
    // ADD, not SET: concurrent requests must not lose counts, and at 19/s they
    // were concurrent — a read-modify-write would have undercounted the very
    // incident this exists for.
    expect(input.UpdateExpression).toContain("ADD");
    expect(input.ExpressionAttributeValues[":one"]).toBe(1);
  });

  test("two apps in one org are counted apart", async () => {
    await authorizer.handler(siteEvent(`/o/${ORG}/appone/site/x`));
    await authorizer.handler(siteEvent(`/o/${ORG}/apptwo/site/x`));
    const keys = updates().map((c) => c.input.Key.pk);
    expect(new Set(keys).size).toBe(2);
  });

  // The property that makes this safe to put on the hot path at all.
  test("a counter that throws does NOT deny the request", async () => {
    sendImpl = async () => {
      throw new Error("DynamoDB is having a bad day");
    };
    const res = await authorizer.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(res.context.authenticated).toBe("false");
  });

  test("a path with no org/app is not counted at all", async () => {
    await authorizer.handler(siteEvent("/mcp"));
    expect(updates()).toHaveLength(0);
  });
});

describe("frontend authorizer request counting — origin lock", () => {
  // A direct hit on the first-party URL is a scanner or a crawler, not
  // something the organization did. Billing an org for someone else's probing
  // would be wrong, so a request the origin lock refuses is never counted.
  test("a request refused by the origin lock is not counted", async () => {
    jest.resetModules();
    sends.length = 0;
    sendImpl = async () => ({});
    process.env.appContentDomain = "dilaya-apps.eu";
    process.env.appContentOriginSecret = "s3cret";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const locked = require("../lib/frontend-authorizer/index.js");
    const res = await locked.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(false);
    expect(updates()).toHaveLength(0);
    delete process.env.appContentDomain;
    delete process.env.appContentOriginSecret;
  });
});
