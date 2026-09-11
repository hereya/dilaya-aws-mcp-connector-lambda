import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type { StackContext } from "./context";

export function createAppCrons(stack: cdk.Stack, ctx: StackContext): void {
  const { appLambdaArnPattern, fn } = ctx;

  // -----------------------------------------------------------------------
  // App crons — EventBridge Scheduler invoking per-app Lambdas DIRECTLY.
  //
  // "Scheduled deterministic work" for apps: the connector creates schedules
  // (recurring cron() or one-shot at(), e.g. booking reminders) in ONE
  // dedicated group, each targeting an app Lambda with a
  // `{ dilayaCron: { name, schema, orgId } }` payload the `hereya` runtime
  // recognizes. Invocation is IAM (Scheduler assumes the invoke role below)
  // — never through the public API, so a cron event cannot be forged from
  // outside. Retry policy is set connector-side and deliberately SHORT
  // (transient-only): a failed business action must fail loudly, not be
  // replayed hours later.
  // -----------------------------------------------------------------------

  const appCronGroup = new scheduler.CfnScheduleGroup(stack, "AppCronGroup", {
    name: `${stack.stackName}-app-crons`,
  });
  const appCronInvokeRole = new iam.Role(stack, "AppCronInvokeRole", {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
      conditions: { StringEquals: { "aws:SourceAccount": stack.account } },
    }),
    description: "Assumed by EventBridge Scheduler to invoke per-app Lambdas (dilaya app crons).",
  });
  appCronInvokeRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [appLambdaArnPattern],
    })
  );
  fn.addEnvironment("APP_CRON_GROUP_NAME", appCronGroup.name!);
  fn.addEnvironment("APP_CRON_INVOKE_ROLE_ARN", appCronInvokeRole.roleArn);
  // Connector manages schedules ONLY inside its own group; the pass-role is
  // pinned to the invoke role AND to the Scheduler service.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "scheduler:CreateSchedule",
        "scheduler:UpdateSchedule",
        "scheduler:DeleteSchedule",
        "scheduler:GetSchedule",
      ],
      resources: [
        `arn:aws:scheduler:${stack.region}:${stack.account}:schedule/${appCronGroup.name}/*`,
      ],
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["scheduler:ListSchedules"],
      resources: ["*"],
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [appCronInvokeRole.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
    })
  );
}