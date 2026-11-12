import { FRONTEND_AUTHORIZER_VOLUME_THRESHOLD } from "../../lib/stack/alarms/traffic";
import { alarmsBy, useStackFixture, WIRED } from "./helpers";

describe("connector core alarms", () => {
  const template = useStackFixture("connector-core-alarms-", "TestStack", {
    clearOptionalEnv: true,
  });

  // --- Volume (2026-08-27) ----------------------------------------------
  // Every alarm above counts FAILURES, and on 2026-08-27 that turned out to
  // be one shared blind spot rather than several: a single browser called one
  // tenant route 17 386 times in under two hours (10-19 req/s, sustained,
  // ~70 % of the day's connector traffic) and EVERY request answered 200.
  // Lambda Errors 0, gateway 5xx 0, CloudFront 5xxErrorRate 0 %, VM heartbeat
  // 60/60 — all 32 alarms in the account structurally silent, because not one
  // of them looks at a volume. The only witness was the invocation count,
  // which nobody reads between two sweeps.
  test("something watches VOLUME, not only failure", () => {
    expect(alarmsBy(template(WIRED), "Invocations")).toHaveLength(1);
  });

  // The frontend authorizer is the one place that sees every tenant site/auth
  // request (authorizerResultTtlInSeconds: 0 — no caching, so one invocation
  // per request), and that traffic is the only UNBOUNDED population here:
  // it is public browser traffic. The rest is agents and crons, whose rate we
  // set ourselves.
  test("the volume alarm watches the path that public browsers can flood", () => {
    const alarm = alarmsBy(template(WIRED), "Invocations")[0] as any;
    const fnDim = alarm.Properties.Dimensions.find(
      (d: any) => d.Name === "FunctionName"
    );
    expect(JSON.stringify(fnDim.Value)).toContain("FrontendAuthorizer");
  });

  // Calibrated the opposite way round from the failure alarms: those sit just
  // above an empirically zero floor, this one must sit far enough above a
  // BUSY baseline to never cry wolf. First set at 3 000/h, it came to fire on
  // a tenant's legitimate traffic, so it was raised to 8 000/h: above the
  // legitimate peak observed, and still more than four times below the
  // ~36 000/h of the incident. The number is pinned here as a literal ON
  // PURPOSE, next to the constant: changing the constant alone must turn this
  // test red, so that the threshold never moves without someone re-reading the
  // reasoning. An hourly period is deliberate too: this asks "is someone
  // burning money right now?", which does not get a better answer for being
  // asked every five minutes, and a 5-minute window at the same rate would
  // fire on legitimate short bursts.
  test("the volume threshold clears real traffic by a wide margin", () => {
    const alarm = alarmsBy(template(WIRED), "Invocations")[0] as any;
    expect(FRONTEND_AUTHORIZER_VOLUME_THRESHOLD).toBe(8000);
    expect(alarm.Properties.Threshold).toBe(FRONTEND_AUTHORIZER_VOLUME_THRESHOLD);
    expect(alarm.Properties.AlarmDescription).toContain(">= 8000 in 1 hour");
    // The stale calibration must not survive in what the reader is paged with.
    expect(alarm.Properties.AlarmDescription).not.toMatch(/3000|2-190/);
    expect(alarm.Properties.Period).toBe(3600);
    expect(alarm.Properties.Statistic).toBe("Sum");
    expect(alarm.Properties.EvaluationPeriods).toBe(1);
  });
});
