// --- The wake half (2026-08-25) --------------------------------------------
// Telegram tells Jonatan; the wake tells the AGENT. These pin the envelope's
// shape, because the connector refuses anything that carries a tenant selector
// — a "helpful" org field added here would break the wake, loudly, in prod.
describe("alarm-relay wake envelope", () => {
  const { envelopeFor } = require("../../lib/alarm-relay/wake.js");

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
