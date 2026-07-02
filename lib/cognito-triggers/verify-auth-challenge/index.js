// Verify-auth-challenge — checks the OTP against the DynamoDB record keyed by
// (user_pool_id, email). Pool-agnostic; reused across every per-app pool.
const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const TABLE_NAME = process.env.OTP_TABLE_NAME;
const MAX_ATTEMPTS = 3;

exports.handler = async (event) => {
  const email = event.request.userAttributes.email;
  const poolId = event.userPoolId;
  const emailVerified = event.request.userAttributes.email_verified === "true";
  const providedOtp = event.request.challengeAnswer;

  try {
    const result = await dynamo.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pool_id: poolId, email },
      })
    );

    if (!result.Item) {
      event.response.answerCorrect = false;
      return event;
    }

    const { otp, ttl, attempts = 0 } = result.Item;
    const now = Math.floor(Date.now() / 1000);

    if (ttl < now) {
      await dynamo.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { pool_id: poolId, email } })
      );
      event.response.answerCorrect = false;
      return event;
    }

    if (attempts >= MAX_ATTEMPTS) {
      await dynamo.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { pool_id: poolId, email } })
      );
      event.response.answerCorrect = false;
      return event;
    }

    if (otp === providedOtp) {
      await dynamo.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { pool_id: poolId, email } })
      );

      if (!emailVerified) {
        await cognito.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: poolId,
            Username: event.userName,
            UserAttributes: [{ Name: "email_verified", Value: "true" }],
          })
        );
      }

      event.response.answerCorrect = true;
    } else {
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pool_id: poolId, email },
          UpdateExpression:
            "SET attempts = if_not_exists(attempts, :zero) + :inc",
          ExpressionAttributeValues: { ":zero": 0, ":inc": 1 },
        })
      );
      event.response.answerCorrect = false;
    }
  } catch (err) {
    console.error("verify-auth-challenge error:", err);
    event.response.answerCorrect = false;
  }

  return event;
};
