// The LOGIN TREE's own minute counter (t_login_burst_authlambda, 2026-10-11).
//
// 10/10, 20:54Z: one Google Cloud address loaded juliefaitout's /auth/login 101
// times in 10 s. Each load is a 3-5 s cold render on the auth Lambda — ONE
// function, 50 reserved slots, shared by every tenant site — so that single
// address held 29 of the 50; the 06/10 variant of the same scanner reached the
// cap (117 throttles) and every site's login page was down for the burst. At
// 606 a minute the burst sat far under the 1 000/minute guard and the
// 2 000/quarter-hour window, both sized for a site's own pages. A login is at
// most five requests, so /auth/* gets its own brake: 60 per (app, address,
// minute), enforced, writing nothing on any other path. Shared scaffolding and
// the other two counters' suites: test/rate-guard-helpers.ts, test/rate-guard.test.ts,
// test/rate-guard-window.test.ts.
import {
  ORG,
  authWrites,
  guardLinesOf,
  load,
  rateWrites,
  resetState,
  siteEvent,
  state,
  windowWrites,
} from "./rate-guard-helpers";

const LOGIN = `/o/${ORG}/juliefaitout/auth/login`;
const SITE = `/o/${ORG}/juliefaitout/site/x`;

describe("frontend rate guard — the login tree", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetState();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  const guardLines = () => guardLinesOf(warn);

  test("an auth path writes a third row, per (app, hashed ip, MINUTE)", async () => {
    const a = load();
    await a.handler(siteEvent(LOGIN, "136.117.255.232, 1.2.3.4"));
    const w = authWrites();
    expect(w).toHaveLength(1);
    const pk = w[0].input.Key.pk as string;
    expect(pk).toContain(`rateauth#${ORG}#juliefaitout#`);
    expect(pk.endsWith(`#${new Date().toISOString().slice(0, 16)}`)).toBe(true);
    expect(pk).not.toContain("136.117.255.232");
    expect(w[0].input.UpdateExpression).toContain("ADD");
    // The two site counters still run on the same request: the auth brake is
    // added to them, it replaces nothing.
    expect(rateWrites()).toHaveLength(1);
    expect(windowWrites()).toHaveLength(1);
  });

  test("a site path writes NO auth row — the brake costs the site nothing", async () => {
    const a = load();
    await a.handler(siteEvent(SITE, "9.9.9.9, 1.2.3.4"));
    expect(authWrites()).toHaveLength(0);
    expect(rateWrites()).toHaveLength(1);
  });

  // Default = ENFORCING, like the minute guard: a brake that refuses nothing
  // leaves every site's login as exposed as before. This test is what stops a
  // future edit from quietly returning it to a no-op.
  test("over 60 on the login tree, with nothing configured, the request IS refused", async () => {
    const a = load();
    state.authHits = 61;
    const res = await a.handler(siteEvent(LOGIN, "136.117.255.232, 1.2.3.4"));
    expect(res.isAuthorized).toBe(false);
    const line = guardLines()[0];
    expect(line.window).toBe("1m-auth");
    expect(line.blocked).toBe(true);
    expect(line.hits).toBe(61);
    expect(line.limit).toBe(60);
    expect(line.app).toBe("juliefaitout");
    expect(line.path).toBe(LOGIN);
  });

  test("the 60th request of the minute still passes — the limit is exclusive", async () => {
    const a = load();
    state.authHits = 60;
    const res = await a.handler(siteEvent(LOGIN, "136.117.255.232, 1.2.3.4"));
    expect(res.isAuthorized).not.toBe(false);
    expect(guardLines()).toHaveLength(0);
  });

  test("the site counters' verdict is untouched by an auth count that is over", async () => {
    // Same address, over on /auth/*, under everywhere else: the site page is
    // served (the auth brake is a brake on the login tree, not on the address).
    const a = load();
    state.authHits = 500;
    const res = await a.handler(siteEvent(SITE, "136.117.255.232, 1.2.3.4"));
    expect(res.isAuthorized).not.toBe(false);
    expect(guardLines()).toHaveLength(0);
  });

  test("FRONTEND_AUTH_RATE_BLOCK=false returns it to reporting only", async () => {
    const a = load({ FRONTEND_AUTH_RATE_BLOCK: "false" });
    state.authHits = 61;
    const res = await a.handler(siteEvent(LOGIN, "136.117.255.232, 1.2.3.4"));
    expect(res.isAuthorized).not.toBe(false);
    expect(guardLines()[0].window).toBe("1m-auth");
    expect(guardLines()[0].blocked).toBe(false);
  });

  test("FRONTEND_AUTH_RATE_LIMIT tunes the ceiling; 0 removes the counter", async () => {
    let a = load({ FRONTEND_AUTH_RATE_LIMIT: "10" });
    state.authHits = 11;
    expect((await a.handler(siteEvent(LOGIN, "9.9.9.9, 1.2.3.4"))).isAuthorized).toBe(false);
    expect(guardLines()[0].limit).toBe(10);
    resetState();
    a = load({ FRONTEND_AUTH_RATE_LIMIT: "0" });
    state.authHits = 10_000;
    await a.handler(siteEvent(LOGIN, "9.9.9.9, 1.2.3.4"));
    expect(authWrites()).toHaveLength(0);
  });

  // The property without which none of the above is safe to deploy.
  test("an auth counter that cannot be read does NOT deny the request", async () => {
    const a = load();
    state.authHits = NaN;
    const res = await a.handler(siteEvent(LOGIN, "9.9.9.9, 1.2.3.4"));
    expect(res.isAuthorized).not.toBe(false);
  });
});
