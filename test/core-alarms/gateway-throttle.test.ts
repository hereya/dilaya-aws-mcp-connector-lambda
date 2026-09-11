import { useStackFixture } from "./helpers";

// The last-resort ceiling under the per-IP guard (t_09669ba18d5e). The two are
// not interchangeable: the authorizer's guard cuts the one address that is
// looping, this one is global and would throttle every tenant — and `/mcp`
// with them. It exists for what the targeted guard cannot see, and it is the
// only layer that can answer a real 429 (an authorizer refusal is always 403).
describe("gateway last-resort throttle", () => {
  const template = useStackFixture("connector-throttle-", "ThrottleStack");

  function stage(): any {
    const stages = template().findResources("AWS::ApiGatewayV2::Stage");
    return (Object.values(stages)[0] as any).Properties;
  }

  test("the gateway has a ceiling at all", () => {
    const rs = stage().DefaultRouteSettings;
    expect(rs.ThrottlingRateLimit).toBe(100);
    expect(rs.ThrottlingBurstLimit).toBe(200);
  });

  // The number is deliberately absurd rather than tuned. Real traffic is
  // 500-2300 requests per DAY (~0.03/s) and the 2026-08-27 runaway peaked at
  // 19/s. A ceiling anywhere near real traffic would make one tenant's loop
  // everyone's outage — including the agents on /mcp.
  test("the ceiling leaves room for many times the worst second ever recorded", () => {
    const observedWorstRps = 20;
    expect(stage().DefaultRouteSettings.ThrottlingRateLimit).toBeGreaterThanOrEqual(
      observedWorstRps * 5
    );
  });

  // Adding throttling must not silently drop the per-route metrics that make a
  // 5xx attributable — they live in the same property. Since 2026-08-29 those
  // metrics live on the platform routes' own settings (the stage default is
  // off, so runtime-created tenant routes stop billing six custom metrics
  // each); this asserts the throttle did not take them down with it.
  test("per-route metrics survive the addition", () => {
    const settings = Object.values(stage().RouteSettings) as any[];
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((s) => s.DetailedMetricsEnabled === true)).toBe(true);
  });

  // The ceiling has to hold on the platform routes too, and they no longer
  // inherit it — they carry their own copy.
  test("every platform route carries the same ceiling as the default", () => {
    const props = stage();
    for (const setting of Object.values(props.RouteSettings) as any[]) {
      expect(setting.ThrottlingRateLimit).toBe(
        props.DefaultRouteSettings.ThrottlingRateLimit
      );
    }
  });
});
