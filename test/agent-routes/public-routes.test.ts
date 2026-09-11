import { useConnectorTemplate } from "./helpers";

// The multi-tenant connector's agent-loop routes must be STATIC (one deployment
// serves every org) and PUBLIC (no JWT authorizer — the poll token is verified
// inside the Lambda). This synth test locks both facts in: the /o/{orgId}/{app}/
// agent/{proxy+} route exists, with no authorizer, while /mcp keeps its
// authorizer. Minimal env (no customDomain / no Cognito) so no Route53 lookup.
describe("static public agent routes", () => {
  const template = useConnectorTemplate({
    tmpPrefix: "connector-synth-",
    stackId: "TestStack",
    projectEnv: "{}",
  });

  it("exposes ANY /o/{orgId}/{app}/agent/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/agent/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /o/{orgId}/{app}/telegram/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/telegram/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /o/{orgId}/{app}/secrets/{proxy+} with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/secrets/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /mcp-connections/{proxy+} (OAuth consent + DCR callback) with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /mcp-connections/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /o/{orgId}/{app}/mcp/{proxy+} (capability-authenticated gateway) with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/mcp/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("exposes ANY /o/{orgId}/{app}/cron/{proxy+} (capability-authenticated cron gateway) with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /o/{orgId}/{app}/cron/{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("keeps the /mcp route behind the CUSTOM JWT authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /mcp",
      AuthorizationType: "CUSTOM",
    });
  });

  it("the agent route carries no AuthorizerId at all", () => {
    const t = template();
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "ANY /o/{orgId}/{app}/agent/{proxy+}" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });

  it("the secrets route carries no AuthorizerId at all", () => {
    const t = template();
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "ANY /o/{orgId}/{app}/secrets/{proxy+}" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });
});
