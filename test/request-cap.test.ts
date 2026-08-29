// The monthly request cap — the brake that CUTS.
//
// Two brakes sit on this path and they answer different questions. The per-IP
// guard is about a RUNAWAY: one address looping, throttled for a minute, back
// to normal on its own. This one is about the BILL: an organization consuming
// beyond its plan, for a whole month, whose site stops being served until the
// 1st of the next one.
//
// It was argued before it was built. The case against — a monthly cap that
// bites takes a WORKING site off the air for up to three weeks, and lands on
// the customer whose site succeeds — lost to the case for: unbounded exposure
// is worse than a bounded outage, and it is Jonatan's exposure to carry
// (2026-08-28). These tests hold the properties that make it survivable.

const sends: any[] = [];
let orgCount = 1;
let edgeCount: number | undefined;
let orgCap: number | null = 1_000_000;
let capLookupThrows = false;
let counterThrows = false;

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
          const pk = String(cmd.input?.Key?.pk || "");
          const sk = String(cmd.input?.Key?.sk || "");
          if (sk === "org") {
            if (capLookupThrows) return Promise.reject(new Error("registry down"));
            return Promise.resolve({ Item: { maxRequestsMonth: orgCap } });
          }
          if (pk.startsWith("reqcountorg#")) {
            if (counterThrows) return Promise.reject(new Error("ddb down"));
            return Promise.resolve({
              Attributes: {
                requests: orgCount,
                ...(edgeCount === undefined ? {} : { edge_requests: edgeCount }),
              },
            });
          }
          if (pk.startsWith("ratecount#")) {
            return Promise.resolve({ Attributes: { hits: 1 } });
          }
          return Promise.resolve({});
        },
      }),
    },
    GetCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    UpdateCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";

function siteEvent(path: string) {
  return { rawPath: path, headers: {}, requestContext: { http: { path, sourceIp: "1.2.3.4" } } };
}

function load() {
  jest.resetModules();
  sends.length = 0;
  process.env.APP_STATE_TABLE = "test-app-state";
  process.env.registryTableName = "test-registry";
  delete process.env.appContentDomain;
  delete process.env.FRONTEND_RATE_BLOCK;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../lib/frontend-authorizer/index.js");
}

const orgCounterWrites = () =>
  sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("reqcountorg#"));

describe("monthly request cap", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    orgCount = 1;
    edgeCount = undefined;
    orgCap = 1_000_000;
    capLookupThrows = false;
    counterThrows = false;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const capLines = () =>
    warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.type === "request_cap");

  test("counts the org's month in ONE atomic write, not a sum over apps", async () => {
    const a = load();
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    const w = orgCounterWrites();
    expect(w).toHaveLength(1);
    const month = new Date().toISOString().slice(0, 16).slice(0, 7);
    expect(w[0].input.Key.pk).toBe(`reqcountorg#${ORG}#${month}`);
    expect(w[0].input.UpdateExpression).toContain("ADD");
    // Reads its own result — summing per-app rows would be N reads per request.
    // ALL_NEW rather than UPDATED_NEW so the edge count written by the
    // connector rides back on the same write (t_b8f659db595c).
    expect(w[0].input.ReturnValues).toBe("ALL_NEW");
  });

  test("well under the cap, the request is served", async () => {
    const a = load();
    orgCount = 500_000;
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  // The 5% margin is Jonatan's and it does real work: a month's counter is an
  // approximation (best-effort writes), so cutting at exactly 100% would cut
  // some customers early on a number that is not exact to the request.
  test("AT the cap it still serves — the 5% margin is deliberate", async () => {
    const a = load();
    orgCount = 1_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    orgCount = 1_049_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });

  test("past the margin, the site is cut and the cut is written down", async () => {
    const a = load();
    orgCount = 1_050_001;
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`));
    expect(res.isAuthorized).toBe(false);
    const line = capLines()[0];
    expect(line.org).toBe(ORG);
    expect(line.count).toBe(1_050_001);
    expect(line.cap).toBe(1_000_000);
  });

  // `null` is UNLIMITED — a decision, not a gap. Misreading it capped Dilaya's
  // own admin org for ten minutes on 2026-08-28.
  test("an org with NO cap is never cut, however high the count", async () => {
    const a = load();
    orgCap = null;
    orgCount = 999_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  test("...but it is still COUNTED, so the figure exists the day it is capped", async () => {
    const a = load();
    orgCap = null;
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(orgCounterWrites()).toHaveLength(1);
  });

  // A lookup we cannot make must never be the reason a site goes dark.
  test("an unreadable cap does not cut", async () => {
    const a = load();
    capLookupThrows = true;
    orgCount = 999_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });

  // --- edge-served traffic (t_b8f659db595c) --------------------------------
  //
  // This authorizer only ever runs for requests that reach the ORIGIN. A cache
  // hit and every path of a static-mode site are answered by CloudFront alone —
  // measured in prod on 2026-08-28, `GET /` on a static tenant host returned
  // 200 with zero invocations here. The connector folds the CloudFront access
  // log into `edge_requests` on the same item; these tests hold the arithmetic
  // that makes the two numbers safe to combine.

  test("a static org past the cap is cut on the EDGE count alone", async () => {
    const a = load();
    orgCount = 12; // almost nothing reaches the origin: the site is static
    edgeCount = 1_050_001;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });

  // Adding the two would count every dynamic request twice — the log records
  // the SAME request the authorizer just counted — and would cut every
  // dynamic customer at half its allowance.
  test("the two counts are MAXed, never summed", async () => {
    const a = load();
    orgCount = 600_000;
    edgeCount = 600_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  // Logs arrive minutes behind, so early in a month (and for the whole of the
  // first month after this ships) the edge figure trails the live one. It must
  // never drag the count DOWN.
  test("a lagging edge count never lowers the live one", async () => {
    const a = load();
    orgCount = 1_050_001;
    edgeCount = 3;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });

  test("an item with no edge count at all behaves exactly as before", async () => {
    const a = load();
    orgCount = 1_050_001;
    edgeCount = undefined;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });

  test("an unwritable counter does not cut", async () => {
    const a = load();
    counterThrows = true;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });
});
