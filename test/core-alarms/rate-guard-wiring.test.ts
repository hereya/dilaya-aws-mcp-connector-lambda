import { useStackFixture } from "./helpers";

// The gap that let a green deploy ship a guard that refused nothing.
//
// The authorizer's own default was flipped to enforcing, but the STACK kept
// stamping FRONTEND_RATE_BLOCK="false" onto the function — and an explicit env
// var beats a code default, so the deploy went green while the guard stayed
// inert. Nothing in the suite noticed, because every test asserted the
// authorizer's behaviour with env vars it set ITSELF; none asserted what the
// stack actually SENDS. It was caught by reading the deployed function's
// configuration in production.
//
// So this asserts the wiring, not the behaviour: what value leaves the stack.
describe("rate guard wiring (what the stack actually sends)", () => {
  const template = useStackFixture("connector-rate-env-", "RateEnvStack");

  function authorizerEnv(env: Record<string, string> = {}): any {
    const fns = template(env).findResources("AWS::Lambda::Function");
    const authorizer = Object.values(fns).find((f: any) =>
      JSON.stringify(f.Properties?.Environment?.Variables ?? {}).includes(
        "FRONTEND_RATE_LIMIT"
      )
    ) as any;
    return authorizer.Properties.Environment.Variables;
  }

  test("the deployed authorizer is told to ENFORCE, not merely allowed to", () => {
    expect(authorizerEnv().FRONTEND_RATE_BLOCK).toBe("true");
    expect(authorizerEnv().FRONTEND_RATE_LIMIT).toBe("1000");
  });

  test("and the off switch still reaches it", () => {
    expect(authorizerEnv({ frontendRateBlock: "false" }).FRONTEND_RATE_BLOCK).toBe(
      "false"
    );
  });
});
