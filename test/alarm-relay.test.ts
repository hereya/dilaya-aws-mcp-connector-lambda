import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
const { tokenFrom } = require("../lib/alarm-relay/token.js");

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
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-alarm-relay-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(env: Record<string, string | undefined>): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  const BOTH = {
    telegramBotTokenParam: "/dilaya/org/apps/app/telegram/credentials",
    telegramChatId: "8592435915",
  };

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
    const stack = fs.readFileSync(
      path.join(__dirname, "..", "lib", "dilaya-aws-mcp-connector-lambda-stack.ts"),
      "utf8"
    );
    expect(stack).toContain('process.env["telegramBotTokenParam"]');
    expect(stack).toContain('process.env["telegramChatId"]');

    // Declared, not just read — an undeclared input never arrives.
    const hereyarc = fs.readFileSync(path.join(__dirname, "..", "hereyarc.yaml"), "utf8");
    expect(hereyarc).toMatch(/^ {2}telegramBotTokenParam:$/m);
    expect(hereyarc).toMatch(/^ {2}telegramChatId:$/m);
  });

  // A recovery is only worth announcing if something broke. A brand-new alarm is
  // born INSUFFICIENT_DATA and flips to OK as soon as it can judge; with an OK
  // action wired that birth reads as "recovered".
  //
  // Measured on the 2026-08-08 deploy: ELEVEN such messages in 62 seconds
  // (relay log 14:59:49→15:00:51) — the exact noise this package's README
  // refuses for 4xx, arriving through the other door.
  describe("birth-OK suppression", () => {
    const { shouldAnnounce } = require("../lib/alarm-relay/announce.js");

    test("a newly created alarm settling into OK says nothing", () => {
      expect(
        shouldAnnounce({ NewStateValue: "OK", OldStateValue: "INSUFFICIENT_DATA" })
      ).toBe(false);
    });

    test("a REAL recovery is still announced — the rule must not eat it", () => {
      expect(shouldAnnounce({ NewStateValue: "OK", OldStateValue: "ALARM" })).toBe(true);
    });

    test("an ALARM is always announced, whatever it came from", () => {
      for (const from of ["OK", "INSUFFICIENT_DATA", "ALARM", undefined]) {
        expect(shouldAnnounce({ NewStateValue: "ALARM", OldStateValue: from })).toBe(true);
      }
    });

    test("an unparseable payload is still announced rather than swallowed", () => {
      // The handler's fallback shape: better a puzzling message than silence.
      expect(shouldAnnounce({ NewStateValue: "UNKNOWN" })).toBe(true);
    });

    test("OK->OK is not a recovery either", () => {
      expect(shouldAnnounce({ NewStateValue: "OK", OldStateValue: "OK" })).toBe(false);
    });
  });

  // Same extraction as the storage package's relay: the parameter it is pointed
  // at in prod holds the connector's credentials record, not a bare token.
  describe("bot-token extraction", () => {
    test("reads bot_token out of the Telegram credentials record", () => {
      const stored = JSON.stringify({ bot_token: "123456:AAE-secret", secret_token: "webhook" });
      expect(tokenFrom(stored)).toBe("123456:AAE-secret");
    });
    test("accepts a bare token", () => {
      expect(tokenFrom("123456:AAE-secret")).toBe("123456:AAE-secret");
    });
    test("never returns the webhook secret", () => {
      const stored = JSON.stringify({ bot_token: "the-token", secret_token: "NOT-THE-TOKEN" });
      expect(tokenFrom(stored)).not.toContain("NOT-THE-TOKEN");
    });
    test("falls back to the raw value rather than throwing at alarm time", () => {
      expect(tokenFrom("{not json")).toBe("{not json");
      expect(tokenFrom(JSON.stringify({ bot_token: 42 }))).toBe('{"bot_token":42}');
    });
  });
});
