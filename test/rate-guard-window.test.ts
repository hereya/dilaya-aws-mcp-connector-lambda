// The LONG window of the per-IP rate guard (t_rate_guard_sustained, 2026-09-13).
//
// The 2026-09-13 loop: one browser, ~300 requests a minute to /api/auth/me,
// 3 800 in twenty minutes — and never near the 1 000/minute guard, which
// cannot come down (a real visitor's busiest minute is 388). What separates
// a loop from a person is DURATION: a person bursts and stops, a loop keeps
// going. So a second counter, over a window long enough that no visitor ever
// fills it, on the same request and the same table. Shared scaffolding and
// the minute counter's own suite: test/rate-guard-helpers.ts, test/rate-guard.test.ts.
import {
  ORG,
  guardLinesOf,
  load,
  resetState,
  siteEvent,
  state,
  windowWrites,
} from "./rate-guard-helpers";

describe("frontend rate guard — long window", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetState();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  const guardLines = () => guardLinesOf(warn);

//
// The 2026-09-13 loop: one browser, ~300 requests a minute to /api/auth/me,
// 3 800 in twenty minutes — and never near the 1 000/minute guard, which
// cannot come down (a real visitor's busiest minute is 388). What separates
// a loop from a person is DURATION: a person bursts and stops, a loop keeps
// going. So a second counter, over a window long enough that no visitor ever
// fills it, on the same request and the same table.
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
    state.hits = 5; // the minute guard sees nothing wrong
    state.winHits = 101;
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
    state.winHits = 101;
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
    state.winHits = 101;
    await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    const pk = windowWrites()[0].input.Key.pk as string;
    const mm = Number(pk.slice(-2));
    expect(mm % 10).toBe(0);
    expect(guardLines()[0].window).toBe("10m");
  });

  test("the minute line and the window line are distinguishable", async () => {
    const a = load({ FRONTEND_RATE_LIMIT: "10", FRONTEND_RATE_WINDOW_LIMIT: "100" });
    state.hits = 11;
    state.winHits = 101;
    await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    const windows = guardLines().map((l) => l.window).sort();
    expect(windows).toEqual(["15m", "1m"]);
  });

  test("under both limits, still nothing at all", async () => {
    const a = load();
    state.hits = 12;
    state.winHits = 40;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(guardLines()).toHaveLength(0);
  });

  test("FRONTEND_RATE_WINDOW_LIMIT=0 switches the window counter off entirely", async () => {
    const a = load({ FRONTEND_RATE_WINDOW_LIMIT: "0" });
    state.winHits = 99999;
    const res = await a.handler(siteEvent(`/o/${ORG}/cariacomenu/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(windowWrites()).toHaveLength(0);
  });

  test("a window counter that throws does NOT deny the request", async () => {
    const a = load({ FRONTEND_RATE_WINDOW_LIMIT: "1", FRONTEND_RATE_WINDOW_BLOCK: "true" });
    state.winHits = NaN;
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(res.isAuthorized).toBe(true);
  });
});
