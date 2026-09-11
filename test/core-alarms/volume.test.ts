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
  // BUSY baseline to never cry wolf. Background 2-190/h, the incident ~36 000/h
  // — 3 000/h is ~16x the busiest legitimate hour ever measured and ~1/12th of
  // the loop. An hourly period is deliberate too: this asks "is someone
  // burning money right now?", which does not get a better answer for being
  // asked every five minutes, and a 5-minute window at the same rate would
  // fire on legitimate short bursts.
  test("the volume threshold clears real traffic by a wide margin", () => {
    const alarm = alarmsBy(template(WIRED), "Invocations")[0] as any;
    expect(alarm.Properties.Threshold).toBe(3000);
    expect(alarm.Properties.Period).toBe(3600);
    expect(alarm.Properties.Statistic).toBe("Sum");
    expect(alarm.Properties.EvaluationPeriods).toBe(1);
  });
});
