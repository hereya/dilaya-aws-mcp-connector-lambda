import { alarmsBy, metricFilterFor, useStackFixture, WIRED } from "./helpers";

describe("connector core alarms", () => {
  const template = useStackFixture("connector-core-alarms-", "TestStack", {
    clearOptionalEnv: true,
  });

  // --- The rate guard's only witness -------------------------------------
  // The guard ships in COUNT mode: it refuses nothing and logs one line per
  // offending request. So this filter is the ONLY evidence it does anything at
  // all. A component that RUNS without DELIVERING is invisible to every
  // instrument that counts executions — which is how the alarm relay sat broken
  // through two real firings (t_e95d603a0a32).
  test("what the rate guard would have refused is counted, not just logged", () => {
    const t = template(WIRED);
    expect(metricFilterFor(t, "RateGuardTripped").FilterPattern).toBe(
      '{ $.type = "rate_guard" }'
    );
    expect(alarmsBy(t, "RateGuardTripped")).toHaveLength(1);
  });

  // CloudWatch refuses a metric filter carrying BOTH dimensions and a
  // defaultValue, and refuses dimensions at all on a pattern that extracts no
  // named fields. Neither rule is enforced by `cdk synth` — both cost a
  // rolled-back production deploy on 2026-08-27.
  test("the rate-guard filter carries no dimensions CloudWatch would refuse", () => {
    const tr = metricFilterFor(template(WIRED), "RateGuardTripped")
      .MetricTransformations[0];
    expect(tr.Dimensions).toBeUndefined();
    expect(tr.MetricValue).toBe("1");
  });
});
