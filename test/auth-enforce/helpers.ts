// Fixture for the frontend authorizer's ENFORCE suites: the registry rows an
// app has (name alias + app row with the access flags), the app's own
// _auth_config row behind the Data API (a mocked fetch), and the counters the
// handler touches on its way. Same globalThis trick as request-cap/helpers.ts:
// the mock factories re-require this module after jest.resetModules().

type EnforceState = {
  appRow: Record<string, unknown> | null;
  registryThrows: boolean;
  poolId: string | null;
  dataApiThrows: boolean;
  fetches: string[];
};

const g = globalThis as any;
export const state: EnforceState =
  g.__authEnforceState ||
  (g.__authEnforceState = {
    appRow: {},
    registryThrows: false,
    poolId: "eu-west-1_pool",
    dataApiThrows: false,
    fetches: [],
  });

export const secretsManagerMock = () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} });
export const dynamodbMock = () => ({ DynamoDBClient: class {} });
export const ssmMock = () => ({ SSMClient: class {}, GetParameterHistoryCommand: class {} });
export const libDynamodbMock = () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (cmd: any) => {
        const pk = String(cmd.input?.Key?.pk || "");
        const sk = String(cmd.input?.Key?.sk || "");
        if (sk.startsWith("name#")) {
          if (state.registryThrows) return Promise.reject(new Error("registry down"));
          return Promise.resolve({ Item: { appId: "app-uuid" } });
        }
        if (sk.startsWith("app#")) {
          if (state.registryThrows) return Promise.reject(new Error("registry down"));
          return Promise.resolve(state.appRow ? { Item: { status: "active", ...state.appRow } } : {});
        }
        if (sk === "org") return Promise.resolve({ Item: { maxRequestsMonth: null } });
        if (pk.startsWith("reqcountorg#")) return Promise.resolve({ Attributes: { requests: 1 } });
        if (pk.startsWith("ratecount#")) return Promise.resolve({ Attributes: { hits: 1 } });
        return Promise.resolve({});
      },
    }),
  },
  GetCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  UpdateCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
});

export const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";

export function event(path: string, cookie?: string) {
  return {
    rawPath: path,
    headers: cookie ? { cookie } : {},
    requestContext: { http: { path, sourceIp: "1.2.3.4" } },
  };
}

export function load() {
  jest.resetModules();
  process.env.APP_STATE_TABLE = "test-app-state";
  process.env.registryTableName = "test-registry";
  process.env.dataApiUrl = "https://data-api.test";
  delete process.env.appContentDomain;
  delete process.env.FRONTEND_RATE_BLOCK;
  (globalThis as any).fetch = async (url: string) => {
    state.fetches.push(String(url));
    if (state.dataApiThrows) throw new Error("ECONNRESET");
    const records = state.poolId
      ? [[{ stringValue: state.poolId }, { stringValue: "client-id" }]]
      : [];
    return { ok: true, status: 200, json: async () => ({ records }), text: async () => "" };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../lib/frontend-authorizer/index.js");
}

export function suiteSetup() {
  let log: jest.SpyInstance;
  beforeEach(() => {
    state.appRow = {};
    state.registryThrows = false;
    state.poolId = "eu-west-1_pool";
    state.dataApiThrows = false;
    state.fetches.length = 0;
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  return () =>
    log.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.type === "auth_enforced");
}
