import { alarmsBy, useStackFixture, WIRED } from "./helpers";
import { headroomThreshold } from "../../lib/stack/alarms/headroom";
import { lambdaAccountConcurrency } from "../../lib/stack/reserved-concurrency";

// t_concurrency_headroom (11/10/2026): a reservation is also a cap, and the
// only alarm on it was `Throttles >= 1` — which rings once visitors are
// ALREADY refused. On 06/10 the auth Lambda sat at 50/50 with no signal
// before. These alarms say "the margin is going" at 70 % of each ceiling.
describe("concurrency headroom alarms", () => {
  const template = useStackFixture("connector-headroom-", "HeadroomStack", {
    clearOptionalEnv: true,
  });

  const byFunction = (t: any) =>
    alarmsBy(t, "ConcurrentExecutions").filter((a: any) => a.Properties.Dimensions);
  const forLabel = (t: any, label: string) =>
    byFunction(t).find((a: any) =>
      JSON.stringify(a.Properties.Dimensions[0].Value).startsWith(`{"Ref":"${label}`)
    ) as any;

  test("each reserved function watches 70 % of its own reservation", () => {
    const t = template(WIRED);
    expect(forLabel(t, "AuthLambda").Properties.Threshold).toBe(35);
    expect(forLabel(t, "AuthorizerHandler").Properties.Threshold).toBe(35); // McpAuthorizer
    expect(forLabel(t, "FrontendAuthorizer").Properties.Threshold).toBe(140);
    const connector = byFunction(t).find(
      (a: any) => a.Properties.Threshold === 105
    );
    expect(connector).toBeDefined();
    expect(byFunction(t)).toHaveLength(4); // Prm has no reservation → no alarm
  });

  test("a sustained climb fires, a single 5-minute spike does not", () => {
    const a = forLabel(template(WIRED), "AuthLambda").Properties;
    expect(a.Statistic).toBe("Maximum");
    expect(a.Period).toBe(300);
    expect(a.EvaluationPeriods).toBe(3);
    expect(a.DatapointsToAlarm).toBe(2);
    expect(a.TreatMissingData).toBe("notBreaching");
    expect(a.AlarmActions).toHaveLength(1); // wired to the relay like the rest
  });

  // The whole account is the pool every tenant backend draws from; the
  // metric without a FunctionName dimension is that figure.
  test("the account-wide alarm has no dimension and sits at 70 % of the declared limit", () => {
    const account = alarmsBy(template(WIRED), "ConcurrentExecutions").filter(
      (a: any) => !a.Properties.Dimensions
    );
    expect(account).toHaveLength(1);
    expect((account[0] as any).Properties.Threshold).toBe(1400);
    expect((account[0] as any).Properties.Namespace).toBe("AWS/Lambda");
  });

  // The ladder is a parameter deploy: raise the reservation, the alarm moves.
  test("the thresholds derive from the deploy params in force", () => {
    const t = template({
      ...WIRED,
      reservedConcurrencyAuthLambda: "150",
      reservedConcurrencyMcpAuthorizer: "none",
      lambdaAccountConcurrency: "5000",
    });
    expect(forLabel(t, "AuthLambda").Properties.Threshold).toBe(105);
    expect(forLabel(t, "AuthorizerHandler")).toBeUndefined();
    const account = alarmsBy(t, "ConcurrentExecutions").find(
      (a: any) => !a.Properties.Dimensions
    ) as any;
    expect(account.Properties.Threshold).toBe(3500);
  });

  test("the account limit param is a positive integer or nothing", () => {
    expect(lambdaAccountConcurrency({})).toBe(2000);
    expect(lambdaAccountConcurrency({ lambdaAccountConcurrency: " 5000 " })).toBe(5000);
    expect(() => lambdaAccountConcurrency({ lambdaAccountConcurrency: "lots" })).toThrow();
    expect(headroomThreshold(50)).toBe(35);
    expect(headroomThreshold(1)).toBe(1);
  });
});
