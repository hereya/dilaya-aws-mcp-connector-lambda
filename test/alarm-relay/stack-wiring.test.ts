import { Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { BOTH, PKG_ROOT, readLibSources, setupTemplateHarness } from "./helpers";

// CapabilityRejectedAlarm shipped 2026-07-07 with ZERO alarm actions, and the
// task that shipped it recorded "a real recurrence now fires within minutes
// (SNS→Telegram)". There was no SNS and no Telegram. Nothing polls an alarm's
// state, so for a month the only reader was the twice-a-day sweep — exactly the
// delay the alarm existed to remove (found by the 2026-08-08 sweep).
//
// Two things are pinned here, because both failed silently in prod before:
//   1. the alarm actually carries actions, and the topic actually has a
//      subscriber — an alarm with 0 actions and a topic with 0 subscribers both
//      look completely healthy in every dashboard;
//   2. the relay is built from the inputs' VERBATIM names. A package receives
//      only the inputs it declares in hereyarc.yaml; an undeclared or renamed
//      one is dropped in silence while the deploy goes green (2026-08-07, three
//      releases that created nothing).
describe("connector alarm → SNS → Telegram relay", () => {
  const { template } = setupTemplateHarness();

  test("with both inputs: the alarm has actions AND the topic has a subscriber", () => {
    const t = template(BOTH);

    // The alarm speaks on the way in and on the way out. An alert that never
    // says "it's over" trains you to ignore it. Assert on the rendered action
    // list rather than a matcher, so "has an action" cannot pass vacuously.
    const alarms = t.findResources("AWS::CloudWatch::Alarm", {
      Properties: { MetricName: "CapabilityRejected" },
    });
    expect(Object.keys(alarms)).toHaveLength(1);
    const alarmProps = Object.values(alarms)[0].Properties;
    expect(alarmProps.AlarmActions).toHaveLength(1);
    expect(alarmProps.OKActions).toHaveLength(1);

    // ...and both point at the topic that has the subscriber, not at some other
    // ARN. Wiring an alarm to an empty topic is the bug this task is fixing.
    const topicRef = Object.keys(
      t.findResources("AWS::SNS::Topic")
    )[0];
    expect(alarmProps.AlarmActions[0]).toEqual({ Ref: topicRef });
    expect(alarmProps.OKActions[0]).toEqual({ Ref: topicRef });

    // The half that was missing in prod for a month on the OTHER stack: a topic
    // whose subscriber count is zero is indistinguishable from a working one.
    t.resourceCountIs("AWS::SNS::Topic", 1);
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });

    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: {
          TELEGRAM_TOKEN_PARAM: BOTH.telegramBotTokenParam,
          TELEGRAM_CHAT_ID: BOTH.telegramChatId,
        },
      },
    });
  });

  test("the relay may read exactly one SSM parameter — the one it was pointed at", () => {
    const t = template(BOTH);
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: {
              "Fn::Join": Match.arrayWith([
                Match.arrayWith([
                  // the leading slash is stripped before the ARN is formatted
                  Match.stringLikeRegexp(
                    ":parameter/dilaya/org/apps/app/telegram/credentials$"
                  ),
                ]),
              ]),
            },
          }),
        ]),
      },
    });
  });

  // Each of these leaves prod exactly as it was rather than half-wiring it.
  test.each([
    ["neither input", {}],
    ["only the token param", { telegramBotTokenParam: BOTH.telegramBotTokenParam }],
    ["only the chat id", { telegramChatId: BOTH.telegramChatId }],
    ["empty strings", { telegramBotTokenParam: "", telegramChatId: "" }],
  ])("with %s: no topic, no relay, and the alarm keeps no action", (_label, env) => {
    const t = template(env as Record<string, string>);
    t.resourceCountIs("AWS::SNS::Topic", 0);
    t.resourceCountIs("AWS::SNS::Subscription", 0);
    const alarms = t.findResources("AWS::CloudWatch::Alarm", {
      Properties: { MetricName: "CapabilityRejected" },
    });
    expect(Object.keys(alarms)).toHaveLength(1);
    const props = Object.values(alarms)[0].Properties;
    expect(props.AlarmActions).toBeUndefined();
    expect(props.OKActions).toBeUndefined();
  });

  // The names are the contract with release.yml and with hereyarc.yaml. Renaming
  // either side is the 2026-08-07 failure: green deploy, nothing created.
  test("reads the inputs under the same names dilaya/aws-sqlite-data uses", () => {
    // Scans the whole of lib/ rather than one file: the stack used to be a
    // single 3 100-line constructor, and a guard naming that one path reads as
    // green the day the code moves — the failure mode is a check that no longer
    // checks anything. Reading the tree survives any further split.
    const stack = readLibSources();
    expect(stack).toContain('process.env["telegramBotTokenParam"]');
    expect(stack).toContain('process.env["telegramChatId"]');

    // Declared, not just read — an undeclared input never arrives.
    const hereyarc = fs.readFileSync(path.join(PKG_ROOT, "hereyarc.yaml"), "utf8");
    expect(hereyarc).toMatch(/^ {2}telegramBotTokenParam:$/m);
    expect(hereyarc).toMatch(/^ {2}telegramChatId:$/m);
  });
});
