// Shared harness for the auth Lambda passkey suites: env + Data API / registry
// fakes + an API-GW v2 event builder. The AWS SDK modules are runtime-provided
// on Lambda and absent from devDependencies, so each suite virtual-mocks them
// ITSELF (jest.mock is hoisted per test file); this helper only fakes the
// network the Lambda reaches (fetch → Data API, DynamoDB registry) and builds
// events. Import it AFTER the jest.mock calls, BEFORE requiring the Lambda.
process.env.dataApiUrl = "https://data.test";
process.env.registryTableName = "registry";
process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
process.env.AWS_SECRET_ACCESS_KEY = "secret";
delete process.env.capabilitySecretArn;
delete process.env.CAPABILITY_SECRET;

export const ORG = "org-1";
export const RP = "pk-acme.dilaya-apps.eu";

// _auth_config rows by app name: `pk` has passkeys on (rp = RP), `nopk` is an
// older row without the passkey columns at all, `pkoff` has them but off.
const authRows: Record<string, Record<string, unknown>> = {
  pk: { user_pool_id: "eu-west-1_PK", user_pool_client_id: "client-pk", from_email: "noreply@pk.test", passkeys: 1, passkey_rp_id: RP },
  nopk: { user_pool_client_id: "client-nopk", from_email: null },
  pkoff: { user_pool_client_id: "client-off", from_email: null, passkeys: 0, passkey_rp_id: RP },
};

function field(v: unknown) {
  if (v === null || v === undefined) return { isNull: true };
  if (typeof v === "number") return { longValue: v };
  return { stringValue: String(v) };
}

/** The Data API answer for `SELECT * FROM _auth_config` of one app. */
export function authConfigResult(app: string) {
  const row = authRows[app];
  if (!row) return { columnMetadata: [], records: [] };
  const cols = Object.keys(row);
  return { columnMetadata: cols.map((name) => ({ name })), records: [cols.map((c) => field(row[c]))] };
}

/** Install a fetch fake answering the two Data API queries the Lambda makes. */
export function installDataApiFake() {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { sql: string; app_id: string };
    const app = body.app_id.replace(/^app:/, "");
    const json = body.sql.includes("_auth_config")
      ? authConfigResult(app)
      : { columnMetadata: [{ name: "1" }], records: app === "pk" || app === "nopk" || app === "pkoff" ? [[{ longValue: 1 }]] : [] };
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  });
}

/** DynamoDB registry fake: name#<app> → appId `app:<app>`, app row status ok. */
export function registryFake() {
  return {
    send: async (cmd: { input?: { Key?: { sk?: string } } }) => {
      const sk = cmd.input?.Key?.sk ?? "";
      if (sk.startsWith("name#")) return { Item: { appId: `app:${sk.slice(5)}` } };
      if (sk.startsWith("app#")) return { Item: { status: "active" } };
      return {};
    },
  };
}

export interface EventOpts {
  host?: string | null;
  cookie?: string;
  query?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  lang?: string;
}

export function ev(method: string, app: string, action: string, o: EventOpts = {}) {
  const headers: Record<string, string> = { "accept-language": o.lang ?? "fr" };
  if (o.host !== null) headers["x-dilaya-app-host"] = o.host ?? RP;
  if (o.cookie) headers.cookie = o.cookie;
  let body = "";
  if (o.form) {
    body = new URLSearchParams(o.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers["content-type"] = "application/json";
  }
  return {
    rawPath: `/o/${ORG}/${app}/auth/${action}`,
    requestContext: { http: { method } },
    headers,
    queryStringParameters: o.query,
    body,
    isBase64Encoded: false,
  };
}

export interface Res {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body: string;
}

/** An unsigned JWT-shaped access token carrying Cognito's `username` claim. */
export const fakeAccessToken = (username: string) =>
  `h.${Buffer.from(JSON.stringify({ username, scope: "aws.cognito.signin.user.admin" })).toString("base64url")}.s`;

export const cookieNamed = (res: Res, name: string) =>
  (res.cookies ?? []).find((c) => c.startsWith(name + "=")) ?? null;
