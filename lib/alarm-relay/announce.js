// Whether an alarm transition is worth a Telegram message. Kept in its own
// module — like token.js — so it can be unit-tested without loading the AWS SDK
// (the Lambda runtime provides it; this repo does not depend on it).
//
// A recovery is only worth announcing if something actually broke. A BRAND-NEW
// alarm is born INSUFFICIENT_DATA and flips to OK the moment it has enough data
// to judge; with an OK action wired, that birth reads as "recovered" and every
// deploy that creates alarms sends one message per alarm.
//
// Measured, not theorised: the 2026-08-08 deploy of the 13 core alarms produced
// ELEVEN such messages in 62 seconds (relay log 14:59:49→15:00:51), right before
// the chain's own real test. That is exactly the noise this package's README
// refuses for 4xx — "alarming it would train everyone to ignore this topic" —
// arriving through the other door.
//
// So: announce ALARM always; announce OK only when it follows a real ALARM.
// Anything unrecognised is announced rather than swallowed — a puzzling message
// beats silence in a component whose whole job is to not be silent.
function shouldAnnounce(alarm) {
  if (!alarm || alarm.NewStateValue !== "OK") return true;
  return alarm.OldStateValue === "ALARM";
}

module.exports = { shouldAnnounce };
