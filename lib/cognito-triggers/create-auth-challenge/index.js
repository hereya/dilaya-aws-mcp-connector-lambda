// Create-auth-challenge — generates a 6-digit OTP, stores it in DynamoDB with
// TTL, and surfaces it via publicChallengeParameters so the calling Lambda
// (auth-lambda/index.js) can send it by email. Pool-agnostic; OTP key is
// (user_pool_id, email) so concurrent logins from the same email across pools
// don't collide.
//
// A code still in force is REUSED, not replaced (t_otp_resend_race, 19/10).
// Cognito calls this trigger for every new challenge: "Resend code" (a fresh
// InitiateAuth), the retry after a mistyped code (a second round of the same
// session) and the auth Lambda's restart of an expired session. Each used to
// mint a new code and overwrite the one already in the person's inbox — so a
// slow first mail that arrived after the second one carried a dead code, and
// one typo killed the code that had been sent. Reusing it makes every mail of
// the episode carry the SAME code. The wrong-attempt counter is kept (a resend
// no longer hands a guesser 3 fresh tries), and an episode is bounded: past
// MAX_REUSE_AGE_SECONDS since the code was first issued, a new one is minted.

const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.OTP_TABLE_NAME;
const OTP_EXPIRY_SECONDS = parseInt(process.env.OTP_EXPIRY_SECONDS || "300", 10);
const MAX_REUSE_AGE_SECONDS = 15 * 60;
// verify-auth-challenge deletes the record at this many wrong attempts.
const MAX_ATTEMPTS = 3;

/** The code to send again, or null when a new one must be minted. */
async function reusableOtp(poolId, email, now) {
  try {
    const { Item: item } = await client.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pool_id: poolId, email } })
    );
    if (!item || typeof item.otp !== "string") return null;
    const issuedAt = Number(item.issuedAt) || Date.parse(item.createdAt || "") / 1000 || 0;
    if (!(item.ttl > now) || (item.attempts || 0) >= MAX_ATTEMPTS) return null;
    if (now - issuedAt >= MAX_REUSE_AGE_SECONDS) return null;
    // The code is mailed (or typed) again now: it stays valid for a full
    // window from this moment, never past the episode's age bound.
    const ttl = Math.min(now + OTP_EXPIRY_SECONDS, issuedAt + MAX_REUSE_AGE_SECONDS);
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pool_id: poolId, email },
        UpdateExpression: "SET #ttl = :ttl",
        ConditionExpression: "otp = :otp",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":ttl": Math.max(ttl, item.ttl), ":otp": item.otp },
      })
    );
    return item.otp;
  } catch (err) {
    // Unreadable record, or it changed under us: a fresh code is always safe.
    console.error("create-auth-challenge: reuse skipped:", err?.name || err?.message || err);
    return null;
  }
}

exports.handler = async (event) => {
  const email = event.request.userAttributes.email;
  const poolId = event.userPoolId;
  const now = Math.floor(Date.now() / 1000);

  let otp = await reusableOtp(poolId, email, now);
  if (!otp) {
    otp = crypto.randomInt(100000, 999999).toString();
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pool_id: poolId,
          email,
          otp,
          ttl: now + OTP_EXPIRY_SECONDS,
          attempts: 0,
          issuedAt: now,
          createdAt: new Date().toISOString(),
        },
      })
    );
  }

  event.response.publicChallengeParameters = { otp };
  event.response.privateChallengeParameters = { answer: otp };

  return event;
};
