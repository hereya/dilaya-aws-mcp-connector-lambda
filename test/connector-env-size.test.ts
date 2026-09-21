// 2026-09-21: the release that pinned dilaya/aws-agentcore-harness died on
// "environment variables … exceeded the 4KB limit. Measured size: 4152 bytes" —
// UPDATE_FAILED on the Handler, stack rolled back. Nothing before the real
// deploy measures the environment, so this does.
import { Template } from "aws-cdk-lib/assertions";
import { useStackFixture } from "./core-alarms/helpers";

function handlerEnv(t: Template): Record<string, unknown> {
  const fns = Object.values(t.findResources("AWS::Lambda::Function")) as any[];
  const handler = fns.find((f) => f.Properties?.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS);
  return handler.Properties.Environment.Variables;
}

describe("the connector Lambda's environment", () => {
  const template = useStackFixture("connector-env-size-", "EnvSizeStack");

  test("carries the four Cognito triggers as function NAMES — the ARN prefix is not written four times", () => {
    const v = handlerEnv(template()).COGNITO_TRIGGER_LAMBDA_ARNS as any;
    const parts = v["Fn::Join"][1] as any[];
    // Four `Ref`s (a Lambda's Ref is its NAME) joined by commas — no GetAtt Arn.
    expect(parts.filter((p) => typeof p === "object" && p.Ref)).toHaveLength(4);
    expect(JSON.stringify(v)).not.toContain("Fn::GetAtt");
  });
});
