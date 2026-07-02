// Create-auth-challenge — generates a 6-digit OTP, stores it in DynamoDB with
// TTL, and surfaces it via publicChallengeParameters so the calling Lambda
// (auth-lambda/index.js) can send it by email. Pool-agnostic; OTP key is
// (user_pool_id, email) so concurrent logins from the same email across pools
// don't collide.

const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.OTP_TABLE_NAME;
const OTP_EXPIRY_SECONDS = parseInt(process.env.OTP_EXPIRY_SECONDS || "300", 10);

exports.handler = async (event) => {
  const email = event.request.userAttributes.email;
  const poolId = event.userPoolId;
  const otp = crypto.randomInt(100000, 999999).toString();
  const ttl = Math.floor(Date.now() / 1000) + OTP_EXPIRY_SECONDS;

  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pool_id: poolId,
        email,
        otp,
        ttl,
        attempts: 0,
        createdAt: new Date().toISOString(),
      },
    })
  );

  event.response.publicChallengeParameters = { otp };
  event.response.privateChallengeParameters = { answer: otp };

  return event;
};
