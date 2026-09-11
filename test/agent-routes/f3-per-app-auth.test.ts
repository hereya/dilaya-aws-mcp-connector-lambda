import { Match } from "aws-cdk-lib/assertions";
import { useConnectorTemplate } from "./helpers";

// F3: the per-app frontend authorizer + auth Lambda are created UNCONDITIONALLY
// (per-app Cognito pools are runtime; there is no deploy-time pool to gate on).
// This locks the guarded→unconditional change: the minimal env below has NO
// Cognito user pool / client, yet both must still exist and be exported to the
// connector Lambda for F3a route plumbing.
describe("F3 per-app auth infra (unconditional)", () => {
  const template = useConnectorTemplate({
    tmpPrefix: "connector-f3-",
    stackId: "F3Stack",
    projectEnv: "{}", // no Cognito, no dataApiUrl
  });

  it("creates the REQUEST frontend authorizer with no deploy-time Cognito", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      Name: "FrontendAuthorizerV2",
      AuthorizerType: "REQUEST",
    });
  });

  it("exports FRONTEND_AUTHORIZER_ID + AUTH_INTEGRATION_ID to the connector Lambda", () => {
    const t = template();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FRONTEND_AUTHORIZER_ID: Match.anyValue(),
          AUTH_INTEGRATION_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("grants the connector Lambda tag-agnostic Cognito admin incl. AdminDeleteUser", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:CreateUserPool",
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminDeleteUser",
            ]),
          }),
        ]),
      },
    });
  });
});
