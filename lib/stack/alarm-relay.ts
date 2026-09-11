import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as path from "path";
import { LIB_DIR } from "./constants";
import type { StackContext } from "./context";

export function createAlarmRelay(stack: cdk.Stack, ctx: StackContext): void {
  const { capabilityRejectedAlarm, fn, memorySize, timeout } = ctx;

  // --- Alarm → SNS → Telegram -------------------------------------------
  // Both inputs are required; either one missing and no relay is built, which
  // leaves the alarm exactly as it was (visible in CloudWatch, silent). The
  // names below are read VERBATIM from the synth env — a package only ever
  // receives an input it DECLARES under `parameters:` in hereyarc.yaml, and an
  // undeclared one is dropped in silence while the deploy still goes green.
  // That is what cost three releases on 2026-08-07; the two names here match
  // `dilaya/aws-sqlite-data`'s on purpose, so the single pair of `-p` values
  // in release.yml feeds both packages.
  const alarmTelegramTokenParam = process.env["telegramBotTokenParam"] ?? "";
  const alarmTelegramChatId = process.env["telegramChatId"] ?? "";
  // The ops agent's inbox. Deliberately NOT literals in the connector's source:
  // baking one tenant's identity into product code would be a permanent wart on
  // a single deployment that serves everyone. Absent → the wake half stays off
  // and the connector REFUSES any alarm envelope (never a silent default).
  const alarmInboxOrg = process.env["alarmInboxOrg"] ?? "";
  const alarmInboxApp = process.env["alarmInboxApp"] ?? "";
  let alertTopic: sns.Topic | undefined;
  if (alarmTelegramTokenParam !== "" && alarmTelegramChatId !== "") {
    alertTopic = new sns.Topic(stack, "ConnectorAlertTopic", {
      displayName: "Dilaya connector alarms",
    });
    const alarmRelay = new lambda.Function(stack, "AlarmRelay", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LIB_DIR, "alarm-relay")),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        TELEGRAM_TOKEN_PARAM: alarmTelegramTokenParam,
        TELEGRAM_CHAT_ID: alarmTelegramChatId,
        // Waking the ops agent is the OTHER half of an alarm: Telegram tells
        // Jonatan, this tells the agent. Empty (both params absent) → the
        // relay keeps its Telegram-only behaviour, so the two halves can ship
        // independently. See lib/alarm-relay/wake.js.
        CONNECTOR_FUNCTION_NAME: alarmInboxOrg !== "" && alarmInboxApp !== "" ? fn.functionName : "",
      },
    });
    // The ONLY new right, and it points one way: the relay may invoke the
    // connector. It carries no org and no app in its payload — the connector
    // holds the destination in its own configuration — so this grant cannot
    // reach a tenant's inbox even if the relay is compromised.
    if (alarmInboxOrg !== "" && alarmInboxApp !== "") {
      fn.grantInvoke(alarmRelay);
    }
    alarmRelay.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: alarmTelegramTokenParam.replace(/^\//, ""),
            },
            stack,
          ),
        ],
      }),
    );
    alertTopic.addSubscription(new snsSubs.LambdaSubscription(alarmRelay));
  }

  // Wire an alarm to the relay, in BOTH directions — an alert that never says
  // "it's over" trains you to ignore it. Alarms are created unconditionally
  // (they stay visible in CloudWatch, and other subscribers remain possible);
  // only the speaking part depends on the two inputs.
  const alertOn = (alarm: cloudwatch.Alarm): void => {
    if (!alertTopic) return;
    alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    alarm.addOkAction(new cwActions.SnsAction(alertTopic));
  };
  alertOn(capabilityRejectedAlarm);
  ctx.alarmInboxApp = alarmInboxApp;
  ctx.alarmInboxOrg = alarmInboxOrg;
  ctx.alertOn = alertOn;
}