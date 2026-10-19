// t_otp_resend_race (19/10): a Cognito session lives 3 minutes, the code 5 —
// and a first mail can take minutes. A RIGHT code typed into an expired session
// failed as "session expired". The auth Lambda now restarts the session once
// (the new challenge carries the same code) and answers with it.
const mockSend = jest.fn();
class Cmd { input: Record<string, any>; constructor(input: Record<string, any>) { this.input = input; } }
class InitiateAuthCommand extends Cmd {}
class RespondToAuthChallengeCommand extends Cmd {}
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand, RespondToAuthChallengeCommand, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = async () => ({}) }, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => mockRegistry() },
  GetCommand: class extends Cmd {},
  UpdateCommand: class extends Cmd {},
}), { virtual: true });

import { ev, registryFake, installDataApiFake, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
installDataApiFake();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/auth-lambda/index.js");
const verify = (otp: string) =>
  handler(ev("POST", "nopk", "verify", { form: { session: "OLD", otp, email: "jo@acme.fr", return_url: "/x" } })) as Promise<Res>;
const expired = () => Object.assign(new Error("Invalid session for the user, session is expired."), { name: "NotAuthorizedException" });
const signedIn = { AuthenticationResult: { IdToken: "h.eyJleHAiOjk5OTk5OTk5OTl9.s", AccessToken: "a" } };

beforeEach(() => {
  mockSend.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("POST verify on an expired session", () => {
  it("restarts the session once and signs in with the right code", async () => {
    mockSend
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ Session: "NEW", ChallengeParameters: { otp: "123456" } })
      .mockResolvedValueOnce(signedIn);
    const res = await verify("123456");
    expect(res.statusCode).toBe(302);
    const [first, restart, answer] = mockSend.mock.calls.map((c) => c[0] as Cmd);
    expect(first).toBeInstanceOf(RespondToAuthChallengeCommand);
    expect(restart).toBeInstanceOf(InitiateAuthCommand);
    expect(restart.input).toMatchObject({ AuthFlow: "CUSTOM_AUTH", AuthParameters: { USERNAME: "jo@acme.fr" } });
    expect(answer.input).toMatchObject({ Session: "NEW", ChallengeResponses: { ANSWER: "123456" } });
  });

  it("a wrong code on the restarted session keeps the person on a LIVE session", async () => {
    mockSend
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ Session: "NEW" })
      .mockResolvedValueOnce({ Session: "NEW-2" });
    const res = await verify("000000");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Code incorrect\. Veuillez réessayer/);
    expect(res.body).toContain('value="NEW-2"');
  });

  it("any other refusal is not retried", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("Incorrect username or password."), { name: "NotAuthorizedException" }));
    const res = await verify("123456");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(res.body).toMatch(/session expirée/);
  });
});
