// SNS → Telegram relay for the connector's own alarms. Plain committed JS (same
// convention as the other inline Lambdas in this package). The bot token stays
// in an SSM SecureString; only its NAME is configuration.
//
// Why this exists at all: `CapabilityRejectedAlarm` had NO alarm action from the
// day it shipped (2026-07-07). The task that shipped it recorded "a real
// CAPABILITY_DENIED recurrence now fires within minutes (SNS→Telegram)" — there
// was never an SNS, so the only thing that ever read the alarm was the twice-a-day
// sweep. An alarm nobody is subscribed to is a dashboard, not an alert.
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { tokenFrom } = require("./token.js");

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

function formatMessage(alarm) {
  const name = alarm.AlarmName || "alarme inconnue";
  const state = alarm.NewStateValue;
  const reason = alarm.NewStateReason || "";
  // The alarm name carries the CDK construct id, so "CapabilityRejected" is the
  // discriminator that survives the stack's generated suffix.
  const isCapability = /CapabilityRejected/i.test(name);
  if (state === "ALARM") {
    if (isCapability) {
      return (
        `🔴 Connecteur Dilaya — des jetons de capacité sont REFUSÉS par la Data API.\n` +
        `Une Lambda appelle les bases avec un jeton que la VM rejette (signature invalide, ` +
        `clé désynchronisée après un déploiement, ou horloge décalée). Les appels concernés ` +
        `échouent en CAPABILITY_DENIED tant que ça dure.\n` +
        `Voir l'incident bad_signature du 06/07 : la cause était une course au démarrage ` +
        `(resolveSecrets après dispatch), pas une histoire de TTL.\n\n${reason}`
      );
    }
    return `🔴 Connecteur Dilaya — « ${name} » est en ALARME.\n\n${reason}`;
  }
  if (state === "OK") {
    return isCapability
      ? `🟢 Connecteur Dilaya — plus aucun refus de jeton de capacité. « ${name} » est rétablie.`
      : `🟢 Connecteur Dilaya — « ${name} » est rétablie.`;
  }
  return `⚪️ Connecteur Dilaya — « ${name} » : ${state}.\n${reason}`;
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
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage(alarm) }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Log AND throw: a silent failure here is indistinguishable from "no alarm
      // fired", which is the exact failure mode this whole task is about.
      console.error(`telegram sendMessage failed: ${res.status} ${body}`);
      throw new Error(`telegram sendMessage failed: ${res.status}`);
    }
  }
  return { ok: true };
};
