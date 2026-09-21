import { alarmsBy, metricFilterFor, useStackFixture, WIRED } from "./helpers";

// 2026-09-21 (t_mcp_403_no_alarm): /mcp answered 403 to almost everyone for
// ~2 h after a landing deploy of ours broke ordinary members' token refresh —
// 188 refusals, and none of the 37 alarms rang, because a refusal is neither an
// error nor a 5xx. Baseline measured over the 7 days before: ZERO 403 on /mcp.
describe("refusals on /mcp ring", () => {
  const template = useStackFixture("connector-mcp-refusals-", "RefusalsStack", {
    clearOptionalEnv: true,
  });

  // The count lives on the ACCESS LOG: the gateway caches a refusal 5 min, so
  // a retrying client is refused without the authorizer running at all.
  test("the 403s are counted on the access log, as strings, by path", () => {
    const f = metricFilterFor(template(WIRED), "Mcp403");
    expect(f.FilterPattern).toBe('{ $.status = "403" && $.path = "/mcp" }');
    expect(f.MetricTransformations[0].DefaultValue).toBe(0);
  });

  test("5 refusals in 15 min ring, and the alarm is wired to the relay", () => {
    const alarms = alarmsBy(template(WIRED), "Mcp403") as any[];
    expect(alarms).toHaveLength(1);
    const p = alarms[0].Properties;
    expect(p.Threshold).toBe(5);
    expect(p.Period).toBe(900);
    expect(p.EvaluationPeriods).toBe(1);
    expect(p.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(p.TreatMissingData).toBe("notBreaching");
    expect(p.AlarmActions?.length).toBeGreaterThan(0);
  });
});
