// Turning an SNS alarm payload into the sentence a human reads on Telegram.
// Kept in its own module — like token.js and announce.js — so it can be
// unit-tested without loading the AWS SDK (the Lambda runtime provides it; this
// repo does not depend on it).
//
// WHY THIS STOPPED BEING A ONE-LINER. This topic was built for the connector's
// own alarms, so every message opened with « Connecteur Dilaya ». Then a SECOND
// stack was pointed at the same relay: dilaya.eu, the single OAuth authorization
// server the multi-tenant connector authenticates every org against. Its alarms
// would have arrived announcing the connector — naming the wrong component in
// the one message whose entire job is to say what broke. An alert that lies
// about its source is worse than no alert: it sends its reader to the wrong
// logs first.
//
// The fix stays in the relay rather than in each publishing stack, because the
// answer is already in the payload. A stack that owns its alarms writes a
// description; ours are prefixed « <source> — » by convention, and CloudWatch
// hands that description to every subscriber. So the relay reads the source it
// is told, and falls back to the connector only for a payload that names none —
// which is exactly what the connector's own alarms do (« Dilaya connector: … »).

// The leading token of a description written as "<source> — <what it means>".
// Anything else (no em dash, an empty description, a foreign alarm) yields
// undefined and the caller keeps its default.
function sourceFrom(description) {
  const match = /^\s*([^—]{1,60}?)\s+—\s+/.exec(description || "");
  return match ? match[1].trim() : undefined;
}

// The part of the description AFTER "<source> — ", i.e. what this alarm means.
// It is written at synth time by whoever knows the metric, so it explains far
// more than the alarm's generated name ever could — and the name is a CDK
// construct id with a hash suffix, which explains nothing at all.
function meaningFrom(description) {
  const text = (description || "").trim();
  if (!text) return "";
  const match = /^\s*[^—]{1,60}?\s+—\s+([\s\S]+)$/.exec(text);
  return (match ? match[1] : text).trim();
}

function formatMessage(alarm) {
  const name = alarm.AlarmName || "alarme inconnue";
  const state = alarm.NewStateValue;
  const reason = alarm.NewStateReason || "";
  const description = alarm.AlarmDescription || "";
  // The alarm name carries the CDK construct id, so "CapabilityRejected" is the
  // discriminator that survives the stack's generated suffix.
  const isCapability = /CapabilityRejected/i.test(name);
  const source = sourceFrom(description) ?? "Connecteur Dilaya";
  const meaning = isCapability ? "" : meaningFrom(description);
  const explains = meaning ? `${meaning}\n\n` : "";

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
    return `🔴 ${source} — « ${name} » est en ALARME.\n\n${explains}${reason}`;
  }
  if (state === "OK") {
    return isCapability
      ? `🟢 Connecteur Dilaya — plus aucun refus de jeton de capacité. « ${name} » est rétablie.`
      : `🟢 ${source} — « ${name} » est rétablie.`;
  }
  return `⚪️ ${source} — « ${name} » : ${state}.\n${reason}`;
}

module.exports = { formatMessage, sourceFrom, meaningFrom };
