// SNS → Telegram relay for the platform's alarms. Plain committed JS (same
// convention as the other inline Lambdas in this package). The bot token stays
// in an SSM SecureString; only its NAME is configuration.
//
// "The platform's", not "the connector's": since 2026-08-10 this relay also
// carries dilaya.eu's alarms (hereya/aws-app-lambda ≥ 0.5.6 publishes to this
// same topic), so the message must name WHICH component broke — see format.js.
//
// Why this exists at all: `CapabilityRejectedAlarm` had NO alarm action from the
// day it shipped (2026-07-07). The task that shipped it recorded "a real
// CAPABILITY_DENIED recurrence now fires within minutes (SNS→Telegram)" — there
// was never an SNS, so the only thing that ever read the alarm was the twice-a-day
// sweep. An alarm nobody is subscribed to is a dashboard, not an alert.
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { tokenFrom } = require("./token.js");
const { shouldAnnounce } = require("./announce.js");
const { formatMessage } = require("./format.js");
const { wakeAgent } = require("./wake.js");

const ssm = new SSMClient({});
let cachedToken = null;

async function botToken() {
  if (cachedToken) return cachedToken;
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.TELEGRAM_TOKEN_PARAM, WithDecryption: true }),
  );
  cachedToken = tokenFrom(res.Parameter.Value);
  return cachedToken;
}

exports.handler = async (event) => {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = await botToken();
  for (const record of event.Records || []) {
    let alarm;
    try {
      alarm = JSON.parse(record.Sns.Message);
    } catch {
      alarm = { AlarmName: record.Sns.Subject, NewStateValue: "UNKNOWN", NewStateReason: record.Sns.Message };
    }
    if (!shouldAnnounce(alarm)) {
      // Logged, never silent: a suppressed message must still be auditable, or
      // this becomes the next thing that fails without anyone noticing.
      console.log(
        `suppressed birth-OK for ${alarm.AlarmName} (${alarm.OldStateValue} -> ${alarm.NewStateValue})`
      );
      continue;
    }
    // Two independent deliveries: Telegram tells Jonatan, the wake tells the
    // agent. Run BOTH before deciding to fail — letting a Telegram outage
    // suppress the wake (or the reverse) would put us back where 2026-08-24
    // left us, with a fired alarm and nobody acting on it.
    const [telegramErr, wakeErr] = await Promise.all([
      (async () => {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: formatMessage(alarm) }),
        });
        if (res.ok) return null;
        const body = await res.text();
        console.error(`telegram sendMessage failed: ${res.status} ${body}`);
        return new Error(`telegram sendMessage failed: ${res.status}`);
      })().catch((err) => err),
      wakeAgent(alarm),
    ]);
    // Log AND throw: a silent failure here is indistinguishable from "no alarm
    // fired", which is the exact failure mode this whole task is about.
    if (telegramErr) throw telegramErr;
    if (wakeErr) throw wakeErr;
  }
  return { ok: true };
};