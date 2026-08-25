import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import { execSync } from "node:child_process";
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
    delete process.env.alarmInboxOrg;
    delete process.env.alarmInboxApp;
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

  // This topic was built for the connector's own alarms, so every message
  // opened with « Connecteur Dilaya ». Since 2026-08-10 a SECOND stack publishes
  // to it — dilaya.eu, the single OAuth authorization server every org is
  // authenticated against — and its alarms would have arrived announcing the
  // connector. An alert that names the wrong component is worse than no alert:
  // it sends its reader to the wrong logs first.
  describe("naming the component that actually broke", () => {
    const {
      formatMessage,
      sourceFrom,
      meaningFrom,
    } = require("../lib/alarm-relay/format.js");

    // What hereya/aws-app-lambda ≥ 0.5.6 writes at synth time.
    const landingAlarm = {
      AlarmName: "p-9ed7133c-…-HandlerErrorsAlarmA4FC7B8A",
      NewStateValue: "ALARM",
      NewStateReason: "Threshold Crossed: 1 datapoint [2.0] was not less than 1.0",
      AlarmDescription:
        "dilaya.eu — Handler Lambda Errors >= 1 in 5 min (expected floor is 0). Stack p-9ed7133c.",
    };

    test("an alarm from dilaya.eu says dilaya.eu, not the connector", () => {
      const message = formatMessage(landingAlarm);
      expect(message).toContain("dilaya.eu");
      expect(message).not.toContain("Connecteur Dilaya");
    });

    test("the recovery names the same source — otherwise the pair is unreadable", () => {
      const message = formatMessage({ ...landingAlarm, NewStateValue: "OK" });
      expect(message.startsWith("🟢 dilaya.eu —")).toBe(true);
    });

    test("what the alarm MEANS travels with it — the name is a hashed construct id", () => {
      expect(formatMessage(landingAlarm)).toContain("Handler Lambda Errors >= 1 in 5 min");
    });

    test("the connector's own alarms are untouched — they name no source", () => {
      // "Dilaya connector: …" has no « — » separator, so the default holds.
      const message = formatMessage({
        AlarmName: "TestStack-HttpApi5xxAlarm",
        NewStateValue: "ALARM",
        NewStateReason: "Threshold Crossed",
        AlarmDescription: "Dilaya connector: API Gateway 5xx >= 1 in 5 min.",
      });
      expect(message.startsWith("🔴 Connecteur Dilaya —")).toBe(true);
    });

    test("the capability alarm keeps its incident-specific wording", () => {
      const message = formatMessage({
        AlarmName: "TestStack-CapabilityRejectedAlarm",
        NewStateValue: "ALARM",
        NewStateReason: "Threshold Crossed",
        AlarmDescription: "Dilaya connector: Data API capability rejections.",
      });
      expect(message).toContain("bad_signature");
      expect(message).toContain("CAPABILITY_DENIED");
    });

    test("a payload with no description at all still produces a message", () => {
      const message = formatMessage({ AlarmName: "X", NewStateValue: "ALARM" });
      expect(message).toContain("« X »");
      expect(message).toContain("Connecteur Dilaya");
    });

    test("an unknown state is announced rather than swallowed", () => {
      expect(formatMessage({ AlarmName: "X", NewStateValue: "INSUFFICIENT_DATA" })).toContain(
        "INSUFFICIENT_DATA"
      );
    });

    // The blanket `*.js` in .gitignore has already swallowed a relay module
    // once (announce.js, 2026-08-08). A missing require() only shows up when an
    // alarm actually fires — i.e. never, until the day it matters.
    test("format.js is a tracked file that ships inside the Lambda asset", () => {
      const relayDir = path.join(__dirname, "..", "lib", "alarm-relay");
      expect(fs.existsSync(path.join(relayDir, "format.js"))).toBe(true);
      expect(
        execSync(`git check-ignore -q lib/alarm-relay/format.js; echo $?`, {
          cwd: path.join(__dirname, ".."),
          encoding: "utf8",
        }).trim()
      ).toBe("1"); // exit 1 = NOT ignored
    });

    test("a prose description is not mistaken for a source name", () => {
      // No « — » separator: nothing to extract, and the whole text is meaning.
      expect(sourceFrom("just a sentence about a metric")).toBeUndefined();
      expect(meaningFrom("just a sentence")).toBe("just a sentence");
      // A long lead-in before a dash is prose, not a component name.
      expect(
        sourceFrom(
          "a description whose first clause runs on well past any plausible component name — then dashes"
        )
      ).toBeUndefined();
    });
  });

  // --- Waking the ops agent (2026-08-25) ------------------------------------
  // The wake is wired ONLY when both inputs are present. Half-configured must
  // stay OFF rather than half-on: an undeclared/absent package parameter is
  // dropped in silence while the deploy still goes green (three wasted
  // releases, 2026-08-07), and the connector refuses an alarm envelope rather
  // than defaulting — so a partial wiring would fail on every alarm instead.
  const INBOX = { alarmInboxOrg: "88120129-295f-476c-b1e1-382ecbc7381a", alarmInboxApp: "dilayadev" };

  function relayEnv(t: Template): Record<string, unknown> {
    const fns = t.findResources("AWS::Lambda::Function", {
      Properties: { Environment: { Variables: { TELEGRAM_CHAT_ID: Match.anyValue() } } },
    });
    expect(Object.keys(fns)).toHaveLength(1);
    return Object.values(fns)[0].Properties.Environment.Variables;
  }

  test("with the inbox configured: the relay may invoke the connector, and knows its name", () => {
    const t = template({ ...BOTH, ...INBOX });
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBeDefined();
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).not.toBe("");

    // The grant exists and points ONE way: relay → connector.
    const policies = t.findResources("AWS::IAM::Policy");
    const invokes = Object.values(policies).flatMap((p: any) =>
      p.Properties.PolicyDocument.Statement.filter(
        (st: any) => String(st.Action).includes("lambda:InvokeFunction")
      )
    );
    expect(invokes.length).toBeGreaterThanOrEqual(1);
  });

  test("with the inbox configured: the CONNECTOR is told where alarms land", () => {
    const t = template({ ...BOTH, ...INBOX });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ALARM_INBOX_ORG: INBOX.alarmInboxOrg,
          ALARM_INBOX_APP: INBOX.alarmInboxApp,
        }),
      },
    });
  });

  test("only ONE half configured → the wake stays entirely off", () => {
    for (const half of [{ alarmInboxOrg: INBOX.alarmInboxOrg }, { alarmInboxApp: INBOX.alarmInboxApp }]) {
      const t = template({ ...BOTH, ...half });
      expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBe("");
      // and the connector is not handed a half-destination
      const fns = t.findResources("AWS::Lambda::Function", {
        Properties: { Environment: { Variables: Match.objectLike({ ALARM_INBOX_ORG: Match.anyValue() }) } },
      });
      expect(Object.keys(fns)).toHaveLength(0);
    }
  });

  test("no inbox configured → today's behaviour, Telegram only", () => {
    const t = template(BOTH);
    expect(relayEnv(t).CONNECTOR_FUNCTION_NAME).toBe("");
  });
});

// --- The wake half (2026-08-25) --------------------------------------------
// Telegram tells Jonatan; the wake tells the AGENT. These pin the envelope's
// shape, because the connector refuses anything that carries a tenant selector
// — a "helpful" org field added here would break the wake, loudly, in prod.
describe("alarm-relay wake envelope", () => {
  const { envelopeFor } = require("../lib/alarm-relay/wake.js");

  const alarm = (over = {}) => ({
    AlarmName: "p-e75e2b77-f895-4255-842d-f15612462041-HandlerErrorsAlarm",
    NewStateValue: "ALARM",
    StateChangeTime: "2026-08-24T10:05:33.722+0000",
    NewStateReason: "Threshold Crossed: 1 datapoint [3.0]",
    ...over,
  });

  it("carries exactly four fields, and NONE of them names a tenant", () => {
    const e = envelopeFor(alarm());
    expect(Object.keys(e).sort()).toEqual(["__dilaya", "alarmName", "at", "state"]);
  });

  it("does not forward AWS's free text", () => {
    expect(JSON.stringify(envelopeFor(alarm()))).not.toContain("Threshold Crossed");
  });

  it("maps the state change time to epoch millis", () => {
    expect(envelopeFor(alarm()).at).toBe(Date.parse("2026-08-24T10:05:33.722+0000"));
  });

  it("relays the three real states", () => {
    for (const s of ["ALARM", "OK", "INSUFFICIENT_DATA"]) {
      expect(envelopeFor(alarm({ NewStateValue: s })).state).toBe(s);
    }
  });

  // UNKNOWN is this relay's own JSON.parse fallback, not a CloudWatch state:
  // sending it would only earn a refusal from the connector.
  it("declines to wake on a non-transition or a nameless alarm", () => {
    expect(envelopeFor(alarm({ NewStateValue: "UNKNOWN" }))).toBeNull();
    expect(envelopeFor(alarm({ AlarmName: "" }))).toBeNull();
    expect(envelopeFor(alarm({ AlarmName: undefined }))).toBeNull();
  });
});

// --- Reading the connector's answer (2026-08-25) -----------------------------
// `LambdaClient.send` does NOT reject when the invoked function throws: the
// failure arrives as `FunctionError` on a 200. The first version of this relay
// ignored that and reported success for a connector that had just died — the
// silent-failure shape the whole feature exists to remove.
describe("alarm-relay wake: reading the connector's answer", () => {
  const sdkPath = "@aws-sdk/client-lambda";

  function withFakeLambda(response: any) {
    const logs = { warn: [] as string[], error: [] as string[] };
    jest.resetModules();
    jest.doMock(
      sdkPath,
      () => ({
        LambdaClient: class {
          async send() {
            if (response instanceof Error) throw response;
            return response;
          }
        },
        InvokeCommand: class {
          constructor(readonly input: unknown) {}
        },
      }),
      { virtual: true },
    );
    jest.spyOn(console, "warn").mockImplementation(((m: any) => {
      logs.warn.push(String(m));
    }) as any);
    jest.spyOn(console, "error").mockImplementation(((m: any) => {
      logs.error.push(String(m));
    }) as any);
    process.env.CONNECTOR_FUNCTION_NAME = "connector-fn";
    const { wakeAgent } = require("../lib/alarm-relay/wake.js");
    return { wakeAgent, logs };
  }

  const ALARM = {
    AlarmName: "p-stack-SomeAlarm",
    NewStateValue: "ALARM",
    StateChangeTime: "2026-08-25T17:00:00.000+0000",
  };
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock(sdkPath);
    delete process.env.CONNECTOR_FUNCTION_NAME;
  });

  it("a clean {ok:true} is a success", async () => {
    const { wakeAgent, logs } = withFakeLambda({ StatusCode: 200, Payload: enc({ ok: true }) });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.error).toHaveLength(0);
    expect(logs.warn).toHaveLength(0);
  });

  // THE regression this block exists for.
  it("FunctionError on a 200 is a FAILURE, not a success", async () => {
    const { wakeAgent, logs } = withFakeLambda({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: enc({ errorType: "Error", errorMessage: "alarm ingest is not configured" }),
    });
    expect(await wakeAgent(ALARM)).toBeInstanceOf(Error);
    expect(logs.error.join(" ")).toContain("connector threw");
  });

  // A refusal is the connector's guard working. Worth logging — a relay sending
  // rubbish is a bug — but not worth failing the invocation over.
  it("a refusal is logged and does NOT fail the invocation", async () => {
    const { wakeAgent, logs } = withFakeLambda({
      StatusCode: 200,
      Payload: enc({ ok: false, refused: "tenant_selector" }),
    });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.warn.join(" ")).toContain("refused");
    expect(logs.error).toHaveLength(0);
  });

  it("an unparseable answer is logged rather than swallowed", async () => {
    const { wakeAgent, logs } = withFakeLambda({ StatusCode: 200, Payload: enc("not-an-object") });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.warn).toHaveLength(1);
  });

  it("a transport failure is still returned as an error", async () => {
    const { wakeAgent, logs } = withFakeLambda(new Error("network down"));
    expect(await wakeAgent(ALARM)).toBeInstanceOf(Error);
    expect(logs.error.join(" ")).toContain("agent wake failed");
  });
});
