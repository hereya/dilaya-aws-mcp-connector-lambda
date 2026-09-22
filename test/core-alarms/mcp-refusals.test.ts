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
  // 401 since 0.1.87 (t_expired_token_403_stuck): the connector answers the
  // refusal, with WWW-Authenticate. `fresh` is REQUIRED: the gateway's own
  // 401 (no Authorization header — scanners) has no refusal word and no holder.
  test("the fresh 401s are counted on the access log, as strings, by path", () => {
    const f = metricFilterFor(template(WIRED), "McpRefused");
    expect(f.FilterPattern).toBe('{ $.status = "401" && $.path = "/mcp" && $.refusal = "fresh" }');
    expect(f.MetricTransformations[0].DefaultValue).toBe(0);
  });

  // t_mcp403_stale_retry_noise: hourly retries on a token dead for 2 h+ rang
  // the alarm twice (16:08Z, 17:17Z) on no new breakage.
  test("stale retries are counted apart, and nothing rings on them", () => {
    const f = metricFilterFor(template(WIRED), "McpRefusedStale");
    expect(f.FilterPattern).toBe('{ $.status = "401" && $.path = "/mcp" && $.refusal = "stale" }');
    expect(alarmsBy(template(WIRED), "McpRefusedStale")).toHaveLength(0);
  });

  test("the access log carries the authorizer's one word", () => {
    const stages = template(WIRED).findResources("AWS::ApiGatewayV2::Stage");
    const formats = Object.values(stages).map((s: any) => s.Properties.AccessLogSettings?.Format ?? "");
    expect(formats.some((f: string) => JSON.parse(f).refusal === "$context.authorizer.refusal")).toBe(true);
  });

  test("5 refusals in 15 min ring, and the alarm is wired to the relay", () => {
    const alarms = alarmsBy(template(WIRED), "McpRefused") as any[];
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
