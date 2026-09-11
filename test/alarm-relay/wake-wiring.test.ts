import { Match } from "aws-cdk-lib/assertions";
import { BOTH, INBOX, relayEnv, setupTemplateHarness } from "./helpers";

describe("connector alarm → SNS → Telegram relay", () => {
  const { template } = setupTemplateHarness();

  test("with the inbox configured: the relay may invoke the connector, and knows its name", () => {
    const t = template({ ...BOTH, ...INBOX });
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBeDefined();
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).not.toBe("");

    // The grant exists and points ONE way: relay → connector.
    const policies = t.findResources("AWS::IAM::Policy");
    const invokes = Object.values(policies).flatMap((p: any) =>
      p.Properties.PolicyDocument.Statement.filter(
        (st: any) => String(st.Action).includes("lambda:InvokeFunction")
      )
    );
    expect(invokes.length).toBeGreaterThanOrEqual(1);
  });

  test("with the inbox configured: the CONNECTOR is told where alarms land", () => {
    const t = template({ ...BOTH, ...INBOX });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ALARM_INBOX_ORG: INBOX.alarmInboxOrg,
          ALARM_INBOX_APP: INBOX.alarmInboxApp,
        }),
      },
    });
  });

  test("only ONE half configured → the wake stays entirely off", () => {
    for (const half of [{ alarmInboxOrg: INBOX.alarmInboxOrg }, { alarmInboxApp: INBOX.alarmInboxApp }]) {
      const t = template({ ...BOTH, ...half });
      expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBe("");
      // and the connector is not handed a half-destination
      const fns = t.findResources("AWS::Lambda::Function", {
        Properties: { Environment: { Variables: Match.objectLike({ ALARM_INBOX_ORG: Match.anyValue() }) } },
      });
      expect(Object.keys(fns)).toHaveLength(0);
    }
  });

  test("no inbox configured → today's behaviour, Telegram only", () => {
    const t = template(BOTH);
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBe("");
  });
});
