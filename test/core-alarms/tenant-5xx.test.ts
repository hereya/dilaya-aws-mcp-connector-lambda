import { alarmsBy, useStackFixture, WIRED } from "./helpers";

describe("connector core alarms", () => {
  const template = useStackFixture("connector-core-alarms-", "TestStack", {
    clearOptionalEnv: true,
  });

  // --- The customer's half: an app's own 5xx is routed to THAT org ------------
  // Until 2026-09-03 the tenant-5xx population was counted and told to nobody:
  // the platform alarm subtracts it on purpose, and no alarm read the remainder.
  // This one exists to ROUTE it through the relay to the connector's analyser.
  test("an app's own 5xx has an alarm of its own, wired to the relay like the others", () => {
    const t = template(WIRED);
    const alarms = alarmsBy(t, "HttpApi5xxTenantApp") as any[];
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0];
    expect(alarm.Properties.Namespace).toBe("Dilaya/Connector");
    expect(alarm.Properties.Threshold).toBe(3);
    expect(alarm.Properties.Period).toBe(300);
    expect(alarm.Properties.Statistic).toBe("Sum");
    expect(alarm.Properties.TreatMissingData).toBe("notBreaching");
    expect(alarm.Properties.AlarmActions).toHaveLength(1);
    expect(alarm.Properties.OKActions).toHaveLength(1);
    expect(alarm.Properties.AlarmDescription).toContain("NOT a platform fault");
  });

  // The analyser reads the access log through Logs Insights. Without the group
  // name the connector skips the analysis in silence ("no_access_log_group"),
  // and without StartQuery it fails it — both are the same customer left
  // uninformed, so both halves are pinned here.
  test("the handler knows the access-log group and may query it — nothing else", () => {
    const t = template(WIRED);
    const fns = Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) =>
      id.startsWith("Handler")
    );
    expect(fns).toHaveLength(1);
    const env = (fns[0]![1] as any).Properties.Environment.Variables;
    expect(env.ACCESS_LOG_GROUP).toBeDefined();
    expect(JSON.stringify(env.ACCESS_LOG_GROUP)).toContain("HttpApiAccessLogs");

    const statements = Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
      (r: any) => r.Properties.PolicyDocument.Statement as any[]
    );
    const start = statements.find((st) => JSON.stringify(st.Action).includes("logs:StartQuery"));
    expect(start).toBeDefined();
    expect(JSON.stringify(start.Resource)).toContain("HttpApiAccessLogs");
    expect(JSON.stringify(start.Action)).not.toContain("logs:PutLogEvents");
    const results = statements.find((st) => JSON.stringify(st.Action).includes("logs:GetQueryResults"));
    expect(results).toBeDefined();
    expect(results.Action).toEqual("logs:GetQueryResults");
  });
});
