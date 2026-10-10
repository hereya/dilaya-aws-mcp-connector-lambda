import { setupTemplateHarness } from "./alarm-relay/helpers";

// The sweeps used to ride a customer's invocation: the request that won a
// DynamoDB claim ran the work inline, before its own answer (8 072 ms on a
// billing tick, 2026-10-10). This rule is what moved them off the request
// path. Three things are pinned, because each one failing is invisible in
// every dashboard: the rule exists at the cadence the sweeps' windows assume,
// it targets the CONNECTOR with the marker envelope and nothing else, and
// EventBridge is actually allowed to invoke it.
describe("sweep tick — the connector's housekeeping off the request path", () => {
  const { template } = setupTemplateHarness();

  test("a rate(5 minutes) rule invokes the handler with the bare sweep envelope", () => {
    const t = template({});

    const rules = t.findResources("AWS::Events::Rule", {
      Properties: { ScheduleExpression: "rate(5 minutes)" },
    });
    expect(Object.keys(rules)).toHaveLength(1);
    const rule = Object.values(rules)[0].Properties;
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);

    // The marker and NOTHING else — no org, no app, no sweep name. A caller
    // cannot steer a sweep at a tenant because there is no field to do it with.
    const target = rule.Targets[0];
    expect(JSON.parse(target.Input)).toEqual({ __dilaya: "sweep" });

    // ...and the target is the connector itself, not the relay or an authorizer.
    const handlers = t.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "handler.handler" },
    });
    expect(Object.keys(handlers)).toHaveLength(1);
    expect(target.Arn).toEqual({ "Fn::GetAtt": [Object.keys(handlers)[0], "Arn"] });
  });

  test("EventBridge is allowed to invoke the connector (a resource policy, not a role statement)", () => {
    const t = template({});
    const perms = t.findResources("AWS::Lambda::Permission", {
      Properties: { Principal: "events.amazonaws.com", Action: "lambda:InvokeFunction" },
    });
    expect(Object.keys(perms)).toHaveLength(1);
    const handlers = t.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "handler.handler" },
    });
    expect(Object.values(perms)[0].Properties.FunctionName).toEqual({
      "Fn::GetAtt": [Object.keys(handlers)[0], "Arn"],
    });
  });

  test("the tick survives every deployment shape, not just the full one", () => {
    // No custom domain, no edge, no crons: the sweeps return at once inside the
    // connector, but the TICK must still exist — a shape-conditional rule is
    // how a feature ends up silently un-swept on one deployment.
    const t = template({ customDomain: undefined });
    t.resourceCountIs("AWS::Events::Rule", 1);
  });
});
