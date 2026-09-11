import { Match } from "aws-cdk-lib/assertions";
import { useConnectorTemplate } from "./helpers";

// Same suite as public-routes.test.ts (identical describe title, identical
// minimal env): the connector-role grants + the AS-assertion-authenticated
// billing/webhook routes that ride alongside the static public agent routes.
describe("static public agent routes", () => {
  const template = useConnectorTemplate({
    tmpPrefix: "connector-synth-",
    stackId: "TestStack",
    projectEnv: "{}",
  });

  it("grants the connector Lambda the /dilaya/*/mcp/* token path — and keeps it OUT of the per-app boundary", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ssm:PutParameter", "ssm:DeleteParameter"]),
            Resource: Match.arrayWith([Match.stringLikeRegexp("parameter/dilaya/\\*/mcp/\\*")]),
          }),
        ]),
      },
    });
    // The per-app permissions boundary must NOT reach the MCP token path: app
    // Lambdas call the gateway with their capability token, never SSM directly.
    const boundaries = t.findResources("AWS::IAM::ManagedPolicy");
    const json = JSON.stringify(boundaries);
    expect(json).not.toContain("/mcp/*");
  });

  it("provisions the app-cron Scheduler group + invoke role, scoped and pass-role-pinned", () => {
    const t = template();
    t.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
      Name: Match.stringLikeRegexp("-app-crons$"),
    });
    // The invoke role is assumable ONLY by the Scheduler service (same-account).
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "scheduler.amazonaws.com" },
            Condition: Match.objectLike({ StringEquals: Match.objectLike({ "aws:SourceAccount": Match.anyValue() }) }),
          }),
        ]),
      },
    });
    // Connector: schedule CRUD only inside its own group + PassRole pinned to Scheduler.
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]),
            Resource: Match.stringLikeRegexp("schedule/.*-app-crons/\\*"),
          }),
        ]),
      },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "iam:PassRole",
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({ "iam:PassedToService": "scheduler.amazonaws.com" }),
            }),
          }),
        ]),
      },
    });
    // The per-app permissions boundary must NOT gain any scheduler access.
    const boundaries = t.findResources("AWS::IAM::ManagedPolicy");
    expect(JSON.stringify(boundaries)).not.toContain("scheduler:");
  });

  it("exposes POST /org-events (AS-assertion-authenticated invalidation webhook) with NO authorizer", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /org-events",
      AuthorizationType: "NONE",
    });
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "POST /org-events" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });

  it("exposes GET /billing/domain-orders (AS-assertion-authenticated read) with NO authorizer", () => {
    // dilaya.eu pulls registered domains + their AWS prices from here to
    // invoice them. It carries an AS-signed assertion, not a user token, so the
    // JWT authorizer would reject it before the connector could verify it —
    // this route existing WITHOUT an authorizer is what makes billing possible
    // at all, and a regression here would silently stop every domain invoice.
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /billing/domain-orders",
      AuthorizationType: "NONE",
    });
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "GET /billing/domain-orders" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });

  it("exposes GET /billing/org-usage (AS-assertion-authenticated read) with NO authorizer", () => {
    // dilaya.eu pulls an org's counted requests from here so it can warn the
    // customer BEFORE the monthly cap stops serving their sites. Same
    // assertion, so the same reasoning: behind the JWT authorizer the call
    // would be rejected before the connector ever verified it, and the only
    // visible symptom would be customers cut off without warning — the exact
    // failure this route exists to prevent.
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /billing/org-usage",
      AuthorizationType: "NONE",
    });
    const routes = t.findResources("AWS::ApiGatewayV2::Route", {
      Properties: { RouteKey: "GET /billing/org-usage" },
    });
    const [route] = Object.values(routes);
    expect(route).toBeDefined();
    expect((route as any).Properties.AuthorizerId).toBeUndefined();
  });

  it("grants the connector Lambda ssm:PutParameter + ssm:DeleteParameter covering /secrets/* writes", () => {
    const t = template();
    // The connector role writes+deletes the secret VALUE under /dilaya/*/apps/*
    // (which subsumes /secrets/<name>); the per-app role only READS /secrets/*.
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ssm:PutParameter", "ssm:DeleteParameter"]),
            // Two resources since the MCP-connection token path joined: the
            // per-app secret tree + the connector-only /mcp/* token tree.
            Resource: Match.arrayWith([Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*")]),
          }),
        ]),
      },
    });
  });
});
