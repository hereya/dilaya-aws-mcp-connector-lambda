import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as triggers from "aws-cdk-lib/triggers";
import * as ssmparam from "aws-cdk-lib/aws-ssm";
import * as path from "path";
import { LIB_DIR } from "../constants";
import type { StackContext } from "../context";

export function createOriginRestamp(stack: cdk.Stack, ctx: StackContext): void {
  const { appContentOriginSecret, frontendAuthorizerRef, timeout } = ctx;
  // --- Origin-secret rotation, deploy-time: the per-org BYOD
  //     distributions are runtime-created (CloudFormation doesn't know
  //     them), so a deploy-time Trigger re-stamps their origin-verify
  //     header with the CURRENT secret. Re-fires when the secret changes
  //     (it is part of the trigger fn's env); idempotent otherwise. A
  //     failed re-stamp FAILS THE DEPLOY on purpose. Zero-downtime via
  //     appContentOriginSecretPrevious (dual-accept in the authorizer).
  if (appContentOriginSecret) {
    // Versioned memory of the CURRENT secret: CloudFormation updates this
    // parameter on each rotation, and SSM keeps the version history — the
    // frontend authorizer auto-accepts version N-1 during a grace window
    // after a rotation, so NO manual "previous secret" is ever needed.
    const originSecretParam = new ssmparam.StringParameter(
      stack,
      "AppContentOriginSecretParam",
      {
        parameterName: `/dilaya/${cdk.Stack.of(stack).stackName}/app-content-origin-secret`,
        stringValue: appContentOriginSecret,
        description:
          "Current app-content origin-lock secret (version history feeds the authorizer's rotation grace window)",
      }
    );
    if (frontendAuthorizerRef) {
      frontendAuthorizerRef.addEnvironment(
        "ORIGIN_SECRET_PARAM",
        originSecretParam.parameterName
      );
      frontendAuthorizerRef.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:GetParameterHistory"],
          resources: [originSecretParam.parameterArn],
        })
      );
    }

    const restampFn = new triggers.TriggerFunction(
      stack,
      "ByodOriginRestamp",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(
          path.join(LIB_DIR, "byod-origin-restamp")
        ),
        timeout: cdk.Duration.minutes(5),
        environment: { ORIGIN_SECRET: appContentOriginSecret },
      }
    );
    restampFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["tag:GetResources"],
        resources: ["*"],
      })
    );
    restampFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudfront:GetDistribution",
          "cloudfront:GetDistributionConfig",
          "cloudfront:UpdateDistribution",
        ],
        resources: [
          `arn:aws:cloudfront::${stack.account}:distribution/*`,
        ],
        conditions: {
          StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
        },
      })
    );
  }

}