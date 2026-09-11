import { useStackFixture } from "./helpers";

// The counter that alarm exists beside writes to APP_STATE_TABLE from the most
// exposed Lambda in the stack — the one every anonymous request reaches. The
// same table holds per-app agent-session secrets, the quota measurement cache
// and the LLM spend ledger, so the grant must stay pinned to the counter rows.
describe("frontend authorizer table grant", () => {
  const template = useStackFixture("connector-authz-grant-", "GrantStack");

  function policies(): any[] {
    const t = template();
    // The authorizer's own inline policy, found by the statement only it has.
    return Object.values(t.findResources("AWS::IAM::Policy"))
      .map((r: any) => r.Properties.PolicyDocument.Statement)
      .filter((sts: any[]) =>
        sts.some(
          (st) =>
            JSON.stringify(st.Condition ?? "").includes("reqcount#") ||
            false
        )
      );
  }

  test("the counter grant is pinned to the counter rows", () => {
    const found = policies();
    expect(found).toHaveLength(1);
    const st = found[0].find((s: any) =>
      JSON.stringify(s.Condition ?? "").includes("reqcount#")
    );
    expect(st.Action).toBe("dynamodb:UpdateItem");
    // Three counter families, and nothing else on this table: the per-app
    // monthly count, the per-IP-per-minute rate guard, and the per-ORG monthly
    // count the plan's request cap is enforced against.
    expect(
      st.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
    ).toEqual(["reqcount#*", "ratecount#*", "reqcountorg#*"]);
  });

  // grantReadWriteData would have been one word shorter and would have put the
  // session secrets, the quota cache and the spend ledger inside the blast
  // radius of the Lambda every stranger on the internet can reach.
  test("adding a counter did not hand the authorizer the whole table", () => {
    const st = policies()[0];
    const writes = st.filter((s: any) => {
      const actions = ([] as string[]).concat(s.Action ?? []);
      return actions.some((a) =>
        ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:*"].includes(a)
      );
    });
    expect(writes).toHaveLength(0);
    // ...and the one Update it does have is conditioned, never bare.
    for (const s of st) {
      const actions = ([] as string[]).concat(s.Action ?? []);
      if (actions.includes("dynamodb:UpdateItem")) {
        expect(s.Condition).toBeDefined();
      }
    }
  });
});
