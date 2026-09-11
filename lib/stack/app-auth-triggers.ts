import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";
import { LIB_DIR } from "./constants";
import type { StackContext } from "./context";

export function createAppAuthTriggers(stack: cdk.Stack, ctx: StackContext): void {
  const { memorySize, timeout } = ctx;

  // -----------------------------------------------------------------------
  // Per-app auth: shared multi-tenant Cognito triggers + OTP table.
  //
  // `enable-auth` provisions a dedicated Cognito user pool per app. All
  // pools across the org are wired to the same 4 challenge trigger Lambdas
  // declared here — the triggers are pool-agnostic (they read
  // event.userPoolId at runtime). The OTP table is keyed by
  // (pool_id, email) so concurrent logins across pools can't collide.
  // -----------------------------------------------------------------------

  const otpTable = new dynamodb.Table(stack, "AppAuthOtpTable", {
    partitionKey: {
      name: "pool_id",
      type: dynamodb.AttributeType.STRING,
    },
    sortKey: { name: "email", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: "ttl",
    // PITR for consistency with every other table this package owns (the
    // contents are TTL'd one-time codes, so it stays empty and this costs
    // nothing). RemovalPolicy stays DESTROY on purpose: nothing here outlives
    // a login attempt, so there is nothing to retain.
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const triggerEnv = { OTP_TABLE_NAME: otpTable.tableName };
  const makeTrigger = (id: string, dir: string) =>
    new lambda.Function(stack, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(LIB_DIR, "cognito-triggers", dir)
      ),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: triggerEnv,
    });

  const preSignUpFn = makeTrigger("PreSignUpTrigger", "pre-sign-up");
  const defineChallengeFn = makeTrigger(
    "DefineAuthChallengeTrigger",
    "define-auth-challenge"
  );
  const createChallengeFn = makeTrigger(
    "CreateAuthChallengeTrigger",
    "create-auth-challenge"
  );
  const verifyChallengeFn = makeTrigger(
    "VerifyAuthChallengeTrigger",
    "verify-auth-challenge"
  );

  otpTable.grantReadWriteData(createChallengeFn);
  otpTable.grantReadWriteData(verifyChallengeFn);

  // Verify trigger also updates the Cognito user attribute `email_verified`.
  // Scoping to resource="*" because per-app pools are created at runtime by
  // the org Lambda — we can't pin a single ARN at stack deploy time.
  verifyChallengeFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["cognito-idp:AdminUpdateUserAttributes"],
      resources: ["*"],
    })
  );

  const triggerArns = [
    preSignUpFn.functionArn,
    defineChallengeFn.functionArn,
    createChallengeFn.functionArn,
    verifyChallengeFn.functionArn,
  ];

  ctx.triggerArns = triggerArns;
}