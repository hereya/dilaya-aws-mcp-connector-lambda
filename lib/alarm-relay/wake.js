// The other half of an alarm: waking the ops agent.
//
// Telegram tells JONATAN. It does not tell the agent — the poller's only wake
// signal is an unread notification in the agent's inbox. On 2026-08-24 both
// platform alarms fired four times each, this relay delivered all 16
// transitions without error, and nothing happened for 28 hours. Detection was
// never the gap.
//
// The envelope carries NO org and NO app on purpose: the connector holds the
// destination in its own configuration, so this relay cannot name a target.
// Even compromised, it reaches exactly one inbox — ours. Do not "helpfully" add
// a tenant field here; the connector refuses the whole invocation if it sees one.
// Required LAZILY, inside the call: the SDK is provided by the Lambda runtime and
// is not installed locally (same as client-ssm here), so a top-level require
// would make this file unloadable — and `envelopeFor` is the part worth testing.
let lambda = null;
function client() {
  if (!lambda) {
    const { LambdaClient } = require("@aws-sdk/client-lambda");
    lambda = new LambdaClient({});
  }
  return lambda;
}

function envelopeFor(alarm) {
  const state = alarm.NewStateValue;
  // Mirror the connector's own allowlist rather than forwarding whatever
  // arrived: an UNKNOWN (our JSON.parse fallback) is not a transition.
  if (state !== "ALARM" && state !== "OK" && state !== "INSUFFICIENT_DATA") return null;
  if (typeof alarm.AlarmName !== "string" || alarm.AlarmName === "") return null;
  const at = Date.parse(alarm.StateChangeTime || "");
  return {
    __dilaya: "alarm",
    alarmName: alarm.AlarmName,
    state,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

/**
 * Best-effort: a wake that fails must never suppress the Telegram message, and
 * vice versa — the caller runs both and reports either failure. Returns the
 * error instead of throwing so the caller can do exactly that.
 */
async function wakeAgent(alarm) {
  const fn = process.env.CONNECTOR_FUNCTION_NAME;
  if (!fn) return null; // not wired (older deploy) — Telegram alone, as before
  const envelope = envelopeFor(alarm);
  if (!envelope) {
    console.log(`no wake for ${alarm.AlarmName}: state ${alarm.NewStateValue} is not a transition`);
    return null;
  }
  try {
    const { InvokeCommand } = require("@aws-sdk/client-lambda");
    await client().send(
      new InvokeCommand({
        FunctionName: fn,
        // Synchronous on purpose: the connector's refusals (misconfiguration, a
        // tenant selector) must be visible in THIS function's logs, not lost in
        // an async invoke nobody reads.
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(envelope)),
      }),
    );
    return null;
  } catch (err) {
    console.error(`agent wake failed for ${alarm.AlarmName}:`, err);
    return err;
  }
}

module.exports = { wakeAgent, envelopeFor };
