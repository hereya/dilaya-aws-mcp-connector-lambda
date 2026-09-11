const { tokenFrom } = require("../../lib/alarm-relay/token.js");

describe("connector alarm → SNS → Telegram relay", () => {
  // A recovery is only worth announcing if something broke. A brand-new alarm is
  // born INSUFFICIENT_DATA and flips to OK as soon as it can judge; with an OK
  // action wired that birth reads as "recovered".
  //
  // Measured on the 2026-08-08 deploy: ELEVEN such messages in 62 seconds
  // (relay log 14:59:49→15:00:51) — the exact noise this package's README
  // refuses for 4xx, arriving through the other door.
  describe("birth-OK suppression", () => {
    const { shouldAnnounce } = require("../../lib/alarm-relay/announce.js");

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
