import { alarmsBy, mathAlarms, metricFilterFor, useStackFixture, WIRED } from "./helpers";

describe("connector core alarms", () => {
  const template = useStackFixture("connector-core-alarms-", "TestStack", {
    clearOptionalEnv: true,
  });

  // --- Whose 5xx is it? (2026-08-20) ------------------------------------
  // Over 30 days and 26 alarms, exactly ONE alarm had ever fired for real:
  // the gateway 5xx one, 4 times on 2026-08-14 — and it was not us. The 10
  // requests behind it all carried `int=200` on `…/komlaba/site-stg/…`: a
  // client's pre-production site answering 500 on two of its own routes. An
  // alarm that cries wolf for someone else's bug is how the only real-time
  // alert this platform has gets ignored.
  //
  // The two patterns below were verified against those very log lines with
  // `aws logs filter-log-events` on the prod access-log group: in the
  // 22:10–22:30Z window the all-5xx pattern matches 8 events and the tenant
  // pattern matches the same 8 — difference 0, alarm silent.
  test("the gateway alarm counts only the 5xx that are ours", () => {
    const alarm = mathAlarms(template(WIRED))[0] as any;
    const expression = alarm.Properties.Metrics.find((m: any) => m.Expression);
    expect(expression.Expression).toBe("total - tenantApp - upstream");
    expect(alarm.Properties.Threshold).toBe(1);
  });

  // The trap this test exists to hold shut: excluding on `integrationStatus`
  // ALONE looks like the obvious fix and is a blinding one — our own handler
  // returning a 500 also answers with `int=200`. A 5xx is the client's only
  // when the integration answered AND the route is one of the tenant `/site`
  // routes, which are the only ones wired straight to an `app-app-*` Lambda.
  test("a 5xx counts as the tenant's only on BOTH signals, never on integrationStatus alone", () => {
    const t = template(WIRED);
    expect(metricFilterFor(t, "HttpApi5xx").FilterPattern).toBe(
      '{ $.status = "5*" }'
    );
    expect(metricFilterFor(t, "HttpApi5xxTenantApp").FilterPattern).toBe(
      '{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }'
    );
  });

  // --- …and a third party's (t_gw_upstream_5xx) ---------------------------
  // 2026-09-03 (slow Pilote freebusy through the MCP gateway) and 2026-09-09
  // (a target's OAuth server failing on the consent page): the connector
  // answered 502/504 ON PURPOSE and the platform alarm read it as ours. The
  // pattern was run through `aws logs test-metric-filter` on 8 shapes and
  // matched exactly the 3 upstream ones. What it must NOT take: a 500 on those
  // routes (our bug), a 502 the GATEWAY made (integrationErrorMessage set,
  // int=200 too), a 504 integration timeout (int "-"), any other route.
  test("a 502/504 the connector chose for a failing third party is not ours — and nothing else is excluded", () => {
    expect(metricFilterFor(template(WIRED), "HttpApi5xxUpstream").FilterPattern).toBe(
      '{ ($.status = "502" || $.status = "504") && $.integrationStatus = "200" && ' +
        '$.integrationErrorMessage = "-" && ($.routeKey = "ANY /o/{orgId}/{app}/mcp/{proxy+}" || ' +
        '$.routeKey = "ANY /mcp-connections/{proxy+}") }'
    );
  });

  // Access-log values are JSON strings, so these are wildcard string matches.
  // A numeric comparison (`$.status >= 500`) reads as a type mismatch and
  // matches nothing — a permanently silent alarm that looks perfectly healthy.
  test("the 5xx patterns match strings, the way the access log actually writes them", () => {
    for (const name of ["HttpApi5xx", "HttpApi5xxTenantApp"]) {
      expect(metricFilterFor(template(WIRED), name).FilterPattern).toContain(
        '$.status = "5*"'
      );
    }
  });

  // Without a default value, a period with no match produces NO datapoint, and
  // `total - tenantApp` is then dropped for that period instead of evaluating
  // — silently disarming the alarm in the exact case it exists for: a platform
  // 5xx during a period with no tenant 5xx.
  test("every 5xx filter emits 0 when they do not match, so the subtraction always evaluates", () => {
    const t = template(WIRED);
    for (const name of ["HttpApi5xx", "HttpApi5xxTenantApp", "HttpApi5xxUpstream"]) {
      expect(
        metricFilterFor(t, name).MetricTransformations[0].DefaultValue
      ).toBe(0);
    }
  });

  // 4xx runs 30–85/day of scanner noise absorbed by tenant apps (all int=200).
  // Alarming it would train everyone to ignore this topic — which is how the
  // alarm layer dies a second time.
  test("4xx is deliberately not alarmed", () => {
    expect(alarmsBy(template(WIRED), "4xx")).toHaveLength(0);
  });
});
