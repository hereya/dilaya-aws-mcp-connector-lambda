import { execSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import { PKG_ROOT } from "./helpers";

describe("connector alarm → SNS → Telegram relay", () => {
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
    } = require("../../lib/alarm-relay/format.js");

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
      const relayDir = path.join(PKG_ROOT, "lib", "alarm-relay");
      expect(fs.existsSync(path.join(relayDir, "format.js"))).toBe(true);
      expect(
        execSync(`git check-ignore -q lib/alarm-relay/format.js; echo $?`, {
          cwd: PKG_ROOT,
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
});
