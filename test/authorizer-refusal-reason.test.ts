// t_mcp_403_no_alarm — on 2026-09-21 the authorizer refused ~everyone for 2 h
// and had written START/END/REPORT only. Every refusal now says WHY, in one
// JSON line, without the token — and claims only once the signature held.
import * as crypto from "crypto";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require("https");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler, authorizeClaims } = require("../lib/authorizer");

const ISS = "https://dilaya.eu/oauth/connect";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims: object, key = privateKey, header: object = { alg: "RS256", kid: "k1" }) {
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.sign("sha256", Buffer.from(body), { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${body}.${sig.toString("base64url")}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: ISS, sub: "u1", client_id: "c1", org_ids: ["org-a"], exp: nowSec() + 600 });

let lines: any[];
async function run(token: string | null) {
  lines = [];
  const headers: Record<string, string> = { "user-agent": "Claude-User" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return handler({ routeKey: "POST /mcp", headers });
}

beforeAll(() => {
  process.env.OAUTH_SERVER_URL = ISS;
  process.env.BOUND_ORG_ID = "";
  process.env.EXPECTED_AUDIENCE = "";
  jest.spyOn(https, "get").mockImplementation((_url: any, cb: any) => {
    const handlers: Record<string, (a?: any) => void> = {};
    const res = { on: (e: string, h: (a?: any) => void) => ((handlers[e] = h), res) };
    cb(res);
    handlers.data(JSON.stringify({ keys: [jwk] }));
    handlers.end();
    return { on: () => undefined };
  });
  jest.spyOn(console, "log").mockImplementation((s: string) => {
    try { lines.push(JSON.parse(s)); } catch { /* not ours */ }
  });
});
afterAll(() => jest.restoreAllMocks());

test("a valid token passes and writes nothing", async () => {
  const r = await run(sign(good()));
  expect(r.isAuthorized).toBe(true);
  expect(lines).toHaveLength(0);
});

test.each([
  ["no_bearer", () => null],
  ["malformed", () => "not-a-jwt"],
  ["bad_alg", () => sign(good(), privateKey, { alg: "HS256", kid: "k1" })],
  ["unknown_kid", () => sign(good(), privateKey, { alg: "RS256", kid: "other" })],
  ["bad_signature", () => sign(good(), stranger)],
  ["expired", () => sign({ ...good(), exp: nowSec() - 90 })],
  ["issuer_mismatch", () => sign({ ...good(), iss: "https://dilaya.eu" })],
  ["no_org_ids", () => sign({ ...good(), org_ids: [] })],
])("refusal %s is named, and the answer to the gateway stays bare", async (reason, make) => {
  const r = await run(make());
  expect(r).toEqual({ isAuthorized: false }); // no `reason` leaks into the gateway response
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ type: "mcp_authorizer_refused", reason, routeKey: "POST /mcp", ua: "Claude-User" });
});

test("who was refused is written ONLY once the signature held — and never the token", async () => {
  const forged = sign(good(), stranger);
  await run(forged);
  expect(lines[0].sub).toBeUndefined(); // attacker-typed payload: not repeated
  const expired = sign({ ...good(), exp: nowSec() - 90 });
  await run(expired);
  expect(lines[0]).toMatchObject({ sub: "u1", clientId: "c1" });
  expect(lines[0].expiredForSec).toBeGreaterThanOrEqual(90);
  expect(JSON.stringify(lines[0])).not.toContain(expired.split(".")[2]);
});

test("authorizeClaims names the audience refusal too", () => {
  const env = { oauthServerUrl: ISS, boundOrgId: "", expectedAudience: "https://app.dilaya.eu/mcp" };
  expect(authorizeClaims({ ...good(), aud: "https://evil/mcp" }, env)).toEqual({
    isAuthorized: false,
    reason: "audience_mismatch",
  });
});
