// t_origin_lock_log (sweep 23/09): the origin lock refused a brand-new
// customer 18 times in 26 minutes and wrote NOTHING — the refusals only showed
// in the gateway access log, while the rate guard and the request cap log
// theirs. One `origin_lock_denied` line per refusal now, shaped for a metric.
import { ORG, load, resetState, siteEvent } from "./rate-guard-helpers";

describe("origin lock refusal leaves a trace", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetState();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const lines = () =>
    warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l?.type === "origin_lock_denied");

  test("a direct first-party hit on a tenant site is refused AND logged with org + app", async () => {
    const a = load({ APP_CONTENT_DOMAIN: "dilaya-apps.eu" });
    const ev = siteEvent(`/o/${ORG}/dossiersproces/site/`);
    (ev.headers as Record<string, string>)["user-agent"] = "Mozilla/5.0 (Android)";
    const res = await a.handler(ev);
    expect(res.isAuthorized).toBe(false);
    const l = lines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ org: ORG, app: "dossiersproces", marker: false });
    expect(String(l[0].ua)).toContain("Android");
  });
});
