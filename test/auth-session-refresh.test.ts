// The long session (t_app_session_longer): the Cognito refresh token rides
// `dilaya_rt` (HttpOnly, Path = the app's /auth/ tree, 30 days re-set on every
// renewal), the login route renews a dead session silently, POST /auth/refresh
// does the same for in-page fetch calls, and logout revokes it. Cognito is
// mocked; the Data API + registry are faked (helpers/auth-lambda-passkey).
const mockSend = jest.fn();
class Cmd { input: unknown; constructor(input: unknown) { this.input = input; } }
class InitiateAuthCommand extends Cmd {}
class RespondToAuthChallengeCommand extends Cmd {}
class GetTokensFromRefreshTokenCommand extends Cmd {}
class RevokeTokenCommand extends Cmd {}
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = mockSend; }, InitiateAuthCommand, RespondToAuthChallengeCommand, GetTokensFromRefreshTokenCommand, RevokeTokenCommand, StartWebAuthnRegistrationCommand: class extends Cmd {}, CompleteWebAuthnRegistrationCommand: class extends Cmd {}, AdminSetUserPasswordCommand: class extends Cmd {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => mockRegistry() }, GetCommand: class extends Cmd {} }), { virtual: true });

import { ev, installDataApiFake, registryFake, cookieNamed, ORG, RP, type Res } from "./helpers/auth-lambda-passkey";
function mockRegistry() { return registryFake(); }
installDataApiFake();
// `_user_access` answers "absent" while this is set — the address was removed.
let revokedAccess = false;
const baseFetch = (global as unknown as { fetch: (u: string, i: { body: string }) => Promise<unknown> }).fetch;
(global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: { body: string }) => {
  if (revokedAccess && JSON.parse(init.body).sql.includes("_user_access")) {
    return { ok: true, status: 200, json: async () => ({ columnMetadata: [], records: [] }), text: async () => "" };
  }
  return baseFetch(url, init);
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, __test__ } = require("../lib/auth-lambda/index.js");
const run = (e: unknown) => handler(e) as Promise<Res>;
const json = (r: Res) => JSON.parse(r.body);

const idToken = (email = "jo@acme.fr") =>
  ["e30", Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
const RT_VANITY = `HttpOnly; Secure; SameSite=Lax; Path=/auth/; Domain=${RP}; Max-Age=2592000`;
const named = (name: string) => (Object.assign(new Error(name), { name }));

beforeEach(() => { mockSend.mockReset(); revokedAccess = false; });

describe("the refresh cookie", () => {
  it("is scoped to the app's auth tree (vanity host and path URL), 30 days", () => {
    expect(__test__.refreshCookie(ORG, "pk", "RT", 2592000, RP)).toBe(`dilaya_rt=RT; ${RT_VANITY}`);
    expect(__test__.refreshCookie(ORG, "pk", "RT", 2592000, null)).toBe(`dilaya_rt=RT; HttpOnly; Secure; SameSite=Lax; Path=/o/${ORG}/pk/auth/; Max-Age=2592000`);
    expect(__test__.REFRESH_IDLE_MAX_AGE).toBe(30 * 86400);
  });

  it("is set by an OTP verify next to the session cookie", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "RT1" } });
    const r = await run(ev("POST", "nopk", "verify", { host: "nopk-acme.dilaya-apps.eu", form: { session: "S", otp: "123456", email: "jo@acme.fr", return_url: "/dash" } }));
    expect(r.statusCode).toBe(302);
    expect(r.headers?.Location).toBe("/dash");
    expect(cookieNamed(r, "dilaya_id_token")).toContain("Path=/; Domain=nopk-acme.dilaya-apps.eu");
    expect(cookieNamed(r, "dilaya_rt")).toBe("dilaya_rt=RT1; HttpOnly; Secure; SameSite=Lax; Path=/auth/; Domain=nopk-acme.dilaya-apps.eu; Max-Age=2592000");
  });

  it("is set by a passkey sign-in", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "RT2" } });
    const credential = { id: "c1", rawId: "c1", type: "public-key", response: { signature: "sig" } };
    const r = await run(ev("POST", "pk", "passkey/finish", { json: { session: "S1", email: "jo@acme.fr", credential, return_url: "/dash" } }));
    expect(json(r)).toEqual({ redirect: "/dash" });
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=RT2; ${RT_VANITY}`);
  });
});

describe("GET login with a refresh cookie and no live session", () => {
  it("renews silently: fresh cookies, rotated refresh token, a never-cached resume page that follows #r=", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "RT-NEW" } });
    const r = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=RT-OLD" }));
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetTokensFromRefreshTokenCommand);
    expect((mockSend.mock.calls[0][0] as Cmd).input).toEqual({ ClientId: "client-pk", RefreshToken: "RT-OLD" });
    expect(r.statusCode).toBe(200);
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
    expect(cookieNamed(r, "dilaya_id_token")).toContain("Max-Age=");
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=RT-NEW; ${RT_VANITY}`);
    expect(r.body).toContain("location.replace(t)");
    expect(r.body).not.toContain('name="email"');
  });

  it("without rotation keeps the same token and slides its 30 days", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken() } });
    const r = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=RT-SAME" }));
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=RT-SAME; ${RT_VANITY}`);
  });

  it("302s straight to a ?return_url= target, still never off the host", async () => {
    mockSend.mockResolvedValue({ AuthenticationResult: { IdToken: idToken() } });
    const ok = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=R", query: { return_url: "/orders?x=1" } }));
    expect(ok.statusCode).toBe(302);
    expect(ok.headers?.Location).toBe("/orders?x=1");
    const evil = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=R", query: { return_url: "https://evil.com/x" } }));
    expect(evil.headers?.Location).toBe("/");
  });

  it("the resume page only follows a relative #r= path", () => {
    const page: string = __test__.resumePage("/");
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const go = (hash: string) => {
      let to = "";
      new Function("location", script)({ hash, replace: (u: string) => { to = u; } });
      return to;
    };
    expect(go("#r=%2Forders%3Fx%3D1")).toBe("/orders?x=1");
    expect(go("#r=%2F%2Fevil.com")).toBe("/");
    expect(go("#r=https%3A%2F%2Fevil.com")).toBe("/");
    expect(go("#r=%2F%5Cevil.com")).toBe("/");
    expect(go("")).toBe("/");
  });

  it("a revoked / expired token clears the cookie and shows the login page, uncached", async () => {
    mockSend.mockRejectedValueOnce(named("NotAuthorizedException"));
    const r = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=DEAD" }));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="email"');
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=; HttpOnly; Secure; SameSite=Lax; Path=/auth/; Domain=${RP}; Max-Age=0`);
    expect(cookieNamed(r, "dilaya_id_token")).toBeNull();
  });

  it("a transient Cognito failure keeps the cookie for the next try", async () => {
    mockSend.mockRejectedValueOnce(named("TooManyRequestsException"));
    const r = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=R" }));
    expect(r.body).toContain('name="email"');
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
    expect(r.cookies ?? []).toEqual([]);
  });

  it("an address removed from _user_access is refused, its token revoked", async () => {
    revokedAccess = true;
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "RT-NEW" } }).mockResolvedValueOnce({});
    const r = await run(ev("GET", "pk", "login", { cookie: "dilaya_rt=R" }));
    expect(r.body).toContain('name="email"');
    expect(cookieNamed(r, "dilaya_rt")).toContain("Max-Age=0");
    expect(cookieNamed(r, "dilaya_id_token")).toBeNull();
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(RevokeTokenCommand);
    expect((mockSend.mock.calls[1][0] as Cmd).input).toEqual({ ClientId: "client-pk", Token: "RT-NEW" });
  });

  it("without the cookie the anonymous page stays the cacheable one, and Cognito is not asked", async () => {
    const r = await run(ev("GET", "pk", "login"));
    expect(r.headers?.["Cache-Control"]).toBe(__test__.LOGIN_PAGE_CACHE_CONTROL);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("POST refresh (in-page fetch calls)", () => {
  it("answers 200 {ok} with fresh cookies", async () => {
    mockSend.mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken() } });
    const r = await run(ev("POST", "pk", "refresh", { cookie: "dilaya_rt=R" }));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: true });
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
    expect(cookieNamed(r, "dilaya_id_token")).not.toBeNull();
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=R; ${RT_VANITY}`);
  });
  it("answers 401 login_required without a cookie, or on a refusal (cookie cleared)", async () => {
    const none = await run(ev("POST", "pk", "refresh"));
    expect(none.statusCode).toBe(401);
    expect(json(none)).toEqual({ error: "login_required" });
    mockSend.mockRejectedValueOnce(named("NotAuthorizedException"));
    const dead = await run(ev("POST", "pk", "refresh", { cookie: "dilaya_rt=R" }));
    expect(dead.statusCode).toBe(401);
    expect(cookieNamed(dead, "dilaya_rt")).toContain("Max-Age=0");
  });
  it("is POST only", async () => {
    expect((await run(ev("GET", "pk", "refresh", { cookie: "dilaya_rt=R" }))).statusCode).toBe(404);
  });
});

describe("GET logout", () => {
  it("revokes the refresh token and clears both cookies", async () => {
    mockSend.mockResolvedValueOnce({});
    const r = await run(ev("GET", "pk", "logout", { cookie: "dilaya_rt=R; dilaya_id_token=x" }));
    expect(r.statusCode).toBe(302);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(RevokeTokenCommand);
    expect((mockSend.mock.calls[0][0] as Cmd).input).toEqual({ ClientId: "client-pk", Token: "R" });
    expect(cookieNamed(r, "dilaya_id_token")).toContain("Max-Age=0");
    expect(cookieNamed(r, "dilaya_rt")).toBe(`dilaya_rt=; HttpOnly; Secure; SameSite=Lax; Path=/auth/; Domain=${RP}; Max-Age=0`);
  });
  it("still signs out when the revocation fails", async () => {
    mockSend.mockRejectedValueOnce(named("UnsupportedTokenTypeException"));
    const r = await run(ev("GET", "pk", "logout", { cookie: "dilaya_rt=R" }));
    expect(r.statusCode).toBe(302);
    expect(cookieNamed(r, "dilaya_rt")).toContain("Max-Age=0");
  });
});

export {};
