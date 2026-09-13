// Per-IP rate guard on tenant frontends (t_80c5ba958ad3).
//
// The 2026-08-27 runaway: one browser, 17 386 requests to one route in under
// two hours, every one answering 200. What it threatened was not the bill (it
// cost five cents) but the SHARED SQLite Data API VM behind every tenant's
// backend — an availability problem for other orgs before it is a cost.
//
// These tests hold the four properties that decide whether this guard is safe
// to run on the hottest path in the platform: it counts per (app, ip, minute)
// rather than per second, it reports before it ever refuses, it cannot be
// dodged by a forged header, and it can never deny a request by failing.

const sends: any[] = [];
let hits = 1; // what the atomic ADD reports back (per-minute bucket)
let winHits = 1; // same, for the long-window bucket (t_rate_guard_sustained)

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
          if (String(cmd.input?.Key?.pk || "").startsWith("ratecount#")) {
            return Promise.resolve({ Attributes: { hits } });
          }
          if (String(cmd.input?.Key?.pk || "").startsWith("ratewin#")) {
            return Promise.resolve({ Attributes: { hits: winHits } });
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
const rateWrites = () =>
  sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("ratecount#"));
const windowWrites = () =>
  sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("ratewin#"));

function siteEvent(path: string, xff?: string) {
  return {
    rawPath: path,
    headers: xff ? { "x-forwarded-for": xff } : {},
    requestContext: { http: { path, sourceIp: "203.0.113.9" } },
  };
}

function load(env: Record<string, string> = {}) {
  jest.resetModules();
  process.env.APP_STATE_TABLE = "test-app-state";
  delete process.env.appContentDomain;
  delete process.env.APP_CONTENT_DOMAIN;
  delete process.env.FRONTEND_RATE_BLOCK;
  delete process.env.FRONTEND_RATE_LIMIT;
  delete process.env.FRONTEND_RATE_WINDOW_LIMIT;
  delete process.env.FRONTEND_RATE_WINDOW_MINUTES;
  delete process.env.FRONTEND_RATE_WINDOW_BLOCK;
  Object.assign(process.env, env);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../lib/frontend-authorizer/index.js");
}

describe("frontend rate guard", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    sends.length = 0;
    hits = 1;
    winHits = 1;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const guardLines = () =>
    warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.type === "rate_guard");

  test("counts per app, per ip, per MINUTE — not per second", () => {
    const a = load();
    return a
      .handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`, "9.9.9.9, 1.2.3.4"))
      .then(() => {
        const pk = rateWrites()[0].input.Key.pk;
        const minute = new Date().toISOString().slice(0, 16);
        expect(pk).toContain(`ratecount#${ORG}#cariacomenu#`);
        expect(pk.endsWith(`#${minute}`)).toBe(true);
        // A rate that resets every second cannot tell a page load from a loop:
        // measured, the busiest legitimate visitor-minute was 388 requests
        // (6.5/s) and the loop's was 1155 (19.3/s) — overlapping ranges. Only
        // the minute-long window separates them.
        expect(rateWrites()[0].input.UpdateExpression).toContain("ADD");
      });
  });

  // The whole point of shipping in COUNT mode: learn who would be cut before
  // cutting anyone. A per-IP limit is wrong about shared addresses.
  // ENFORCING by default since 2026-08-28. A guard that refuses nothing leaves
  // the platform exactly as exposed as before; the margin (1000/min = 2.6x the
  // busiest legitimate visitor-minute ever measured) is what makes enforcing
  // safe. The default must be the enforcing one — this test is what stops a
  // future edit from quietly returning it to a no-op.
  test("over the limit, with nothing configured, the request IS refused", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "10" });
    hits = 11;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(false);
    const line = guardLines()[0];
    expect(line.blocked).toBe(true);
    expect(line.hits).toBe(11);
    expect(line.limit).toBe(10);
    expect(line.app).toBe("cariacomenu");
  });

  // The OFF switch, and it is deliberately the default's inverse rather than a
  // deploy parameter: a package parameter has two halves and forgetting either
  // deploys green while doing nothing (2026-08-07).
  test("FRONTEND_RATE_BLOCK=false returns it to reporting only", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "10", FRONTEND_RATE_BLOCK: "false" });
    hits = 11;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(guardLines()[0].blocked).toBe(false);
  });

  test("under the limit says nothing at all", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "1000" });
    hits = 12;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(guardLines()).toHaveLength(0);
  });

  test("an explicit true is still honoured", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "10", FRONTEND_RATE_BLOCK: "true" });
    hits = 11;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(false);
    expect(guardLines()[0].blocked).toBe(true);
  });

  // The FIRST X-Forwarded-For entry is whatever the client sent. Keying on it
  // would let an abuser reset their bucket every request by rotating a header —
  // a guard that is trivially free to dodge. The CDN-seen entry is the
  // second-to-last, the same rule as the runtime's req.clientIp.
  test("a forged X-Forwarded-For cannot move the bucket", async () => {
    const a = load();
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`, "1.1.1.1, 9.9.9.9, 1.2.3.4"));
    const first = rateWrites()[0].input.Key.pk;
    sends.length = 0;
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`, "2.2.2.2, 9.9.9.9, 1.2.3.4"));
    const second = rateWrites()[0].input.Key.pk;
    // Same real client (9.9.9.9), different forged head → same bucket.
    expect(second).toBe(first);
  });

  test("two genuinely different clients get different buckets", async () => {
    const a = load();
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`, "8.8.8.8, 1.2.3.4"));
    const first = rateWrites()[0].input.Key.pk;
    sends.length = 0;
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`, "7.7.7.7, 1.2.3.4"));
    expect(rateWrites()[0].input.Key.pk).not.toBe(first);
  });

  // The raw address is never a partition key: the row outlives the request by a
  // couple of minutes and there is no reason to keep a visitor's IP to count it.
  test("the bucket key carries a hash, never the address", async () => {
    const a = load();
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`, "8.8.8.8, 1.2.3.4"));
    expect(rateWrites()[0].input.Key.pk).not.toContain("8.8.8.8");
  });

  // The property without which none of the above is safe to deploy.
  test("a rate counter that throws does NOT deny the request", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "1" });
    sends.length = 0;
    const failing = jest
      .spyOn(JSON, "stringify"); // no-op spy so the import above stays used
    failing.mockRestore();
    hits = NaN; // Number(NaN) > limit is false, and must not throw either
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(res.isAuthorized).toBe(true);
  });

  // --- The long window (t_rate_guard_sustained, 2026-09-13) ----------------
  //
  // The 2026-09-13 loop: one browser, ~300 requests a minute to /api/auth/me,
  // 3 800 in twenty minutes — and never near the 1 000/minute guard, which
  // cannot come down (a real visitor's busiest minute is 388). What separates
  // a loop from a person is DURATION: a person bursts and stops, a loop keeps
  // going. So a second counter, over a window long enough that no visitor ever
  // fills it, on the same request and the same table.
  describe("long window", () => {
    test("also counts per (app, ip, 15-MINUTE window) — a tumbling bucket", async () => {
      const a = load();
      await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`, "9.9.9.9, 1.2.3.4"));
      const w = windowWrites();
      expect(w).toHaveLength(1);
      const pk = w[0].input.Key.pk as string;
      expect(pk).toContain(`ratewin#${ORG}#cariacomenu#`);
      // The bucket is the current quarter-hour, YYYY-MM-DDTHH:MM with MM in
      // {00,15,30,45} — a loop straddling two buckets is caught in the second
      // one at the latest.
      const start = pk.slice(pk.lastIndexOf("#") + 1);
      const now = new Date();
      const q = Math.floor(now.getUTCMinutes() / 15) * 15;
      expect(start).toBe(
        now.toISOString().slice(0, 14) + String(q).padStart(2, "0")
      );
      expect(pk).not.toContain("9.9.9.9");
      expect(w[0].input.UpdateExpression).toContain("ADD");
    });

    test("the window limit alone refuses when its block switch is on", async () => {
      const a = load({
        FRONTEND_RATE_WINDOW_LIMIT: "100",
        FRONTEND_RATE_WINDOW_BLOCK: "true",
      });
      hits = 5; // the minute guard sees nothing wrong
      winHits = 101;
      const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      expect(res.isAuthorized).toBe(false);
      const line = guardLines()[0];
      expect(line.window).toBe("15m");
      expect(line.blocked).toBe(true);
      expect(line.hits).toBe(101);
      expect(line.limit).toBe(100);
      expect(line.app).toBe("cariacomenu");
    });

    test("in COUNT mode the window guard reports and lets the request through", async () => {
      const a = load({
        FRONTEND_RATE_WINDOW_LIMIT: "100",
        FRONTEND_RATE_WINDOW_BLOCK: "false",
      });
      winHits = 101;
      const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      expect(res.isAuthorized).toBe(true);
      expect(guardLines()).toHaveLength(1);
      expect(guardLines()[0].window).toBe("15m");
      expect(guardLines()[0].blocked).toBe(false);
    });

    test("the window length is configurable and named in the line", async () => {
      const a = load({
        FRONTEND_RATE_WINDOW_LIMIT: "100",
        FRONTEND_RATE_WINDOW_MINUTES: "10",
      });
      winHits = 101;
      await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      const pk = windowWrites()[0].input.Key.pk as string;
      const mm = Number(pk.slice(-2));
      expect(mm % 10).toBe(0);
      expect(guardLines()[0].window).toBe("10m");
    });

    test("the minute line and the window line are distinguishable", async () => {
      const a = load({ FRONTEND_RATE_LIMIT: "10", FRONTEND_RATE_WINDOW_LIMIT: "100" });
      hits = 11;
      winHits = 101;
      await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      const windows = guardLines().map((l) => l.window).sort();
      expect(windows).toEqual(["15m", "1m"]);
    });

    test("under both limits, still nothing at all", async () => {
      const a = load();
      hits = 12;
      winHits = 40;
      const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      expect(res.isAuthorized).toBe(true);
      expect(guardLines()).toHaveLength(0);
    });

    test("FRONTEND_RATE_WINDOW_LIMIT=0 switches the window counter off entirely", async () => {
      const a = load({ FRONTEND_RATE_WINDOW_LIMIT: "0" });
      winHits = 99999;
      const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
      expect(res.isAuthorized).toBe(true);
      expect(windowWrites()).toHaveLength(0);
    });

    test("a window counter that throws does NOT deny the request", async () => {
      const a = load({ FRONTEND_RATE_WINDOW_LIMIT: "1", FRONTEND_RATE_WINDOW_BLOCK: "true" });
      winHits = NaN;
      const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
      expect(res.isAuthorized).toBe(true);
    });
  });
});
