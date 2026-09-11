// Shared fixture for the monthly-request-cap suites.
//
// The mock state lives on `globalThis` so that it survives the
// `jest.resetModules()` in `load()`: the jest.mock factories re-`require` this
// module after the reset, and must land on the SAME mutable state object the
// test file is writing to.

type CapState = {
  sends: any[];
  orgCount: number;
  edgeCount: number | undefined;
  orgCap: number | null;
  capLookupThrows: boolean;
  counterThrows: boolean;
};

const g = globalThis as any;

export const state: CapState =
  g.__requestCapState ||
  (g.__requestCapState = {
    sends: [],
    orgCount: 1,
    edgeCount: undefined,
    orgCap: 1_000_000,
    capLookupThrows: false,
    counterThrows: false,
  });

export const secretsManagerMock = () => ({
  SecretsManagerClient: class {},
  GetSecretValueCommand: class {},
});

export const dynamodbMock = () => ({ DynamoDBClient: class {} });

export const ssmMock = () => ({ SSMClient: class {}, GetParameterHistoryCommand: class {} });

export const libDynamodbMock = () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (cmd: any) => {
        state.sends.push(cmd);
        const pk = String(cmd.input?.Key?.pk || "");
        const sk = String(cmd.input?.Key?.sk || "");
        if (sk === "org") {
          if (state.capLookupThrows) return Promise.reject(new Error("registry down"));
          return Promise.resolve({ Item: { maxRequestsMonth: state.orgCap } });
        }
        if (pk.startsWith("reqcountorg#")) {
          if (state.counterThrows) return Promise.reject(new Error("ddb down"));
          return Promise.resolve({
            Attributes: {
              requests: state.orgCount,
              ...(state.edgeCount === undefined ? {} : { edge_requests: state.edgeCount }),
            },
          });
        }
        if (pk.startsWith("ratecount#")) {
          return Promise.resolve({ Attributes: { hits: 1 } });
        }
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

export function siteEvent(path: string) {
  return { rawPath: path, headers: {}, requestContext: { http: { path, sourceIp: "1.2.3.4" } } };
}

export function load() {
  jest.resetModules();
  state.sends.length = 0;
  process.env.APP_STATE_TABLE = "test-app-state";
  process.env.registryTableName = "test-registry";
  delete process.env.appContentDomain;
  delete process.env.FRONTEND_RATE_BLOCK;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../lib/frontend-authorizer/index.js");
}

export const orgCounterWrites = () =>
  state.sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("reqcountorg#"));

// Installs the per-test reset + console spies, and hands back the reader for
// the `request_cap` warn lines.
export function capSuiteSetup() {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    state.orgCount = 1;
    state.edgeCount = undefined;
    state.orgCap = 1_000_000;
    state.capLookupThrows = false;
    state.counterThrows = false;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  return () =>
    warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.type === "request_cap");
}
