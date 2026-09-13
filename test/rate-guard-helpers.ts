// Shared scaffolding for the two rate-guard suites (test/rate-guard.test.ts —
// the minute counter — and test/rate-guard-window.test.ts — the long window).
// The SUT is required lazily by load() AFTER jest.resetModules(), so the
// virtual mocks registered here at import time are what it sees.
// The 2026-08-27 runaway: one browser, 17 386 requests to one route in under
// two hours, every one answering 200. What it threatened was not the bill (it
// cost five cents) but the SHARED SQLite Data API VM behind every tenant's
// backend — an availability problem for other orgs before it is a cost.
//
// These tests hold the four properties that decide whether this guard is safe
// to run on the hottest path in the platform: it counts per (app, ip, minute)
// rather than per second, it reports before it ever refuses, it cannot be
// dodged by a forged header, and it can never deny a request by failing.

export const sends: any[] = [];
/** What the atomic ADD reports back: per-minute bucket / long-window bucket. */
export const state = { hits: 1, winHits: 1 };

jest.mock(
  "@aws-sdk/client-secrets-manager",
  () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }),
  { virtual: true }
);
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), {
  virtual: true,
});
jest.mock(
  "@aws-sdk/client-ssm",
  () => ({ SSMClient: class {}, GetParameterHistoryCommand: class {} }),
  { virtual: true }
);
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({
    DynamoDBDocumentClient: {
      from: () => ({
        send: (cmd: any) => {
          sends.push(cmd);
          if (String(cmd.input?.Key?.pk || "").startsWith("ratecount#")) {
            return Promise.resolve({ Attributes: { hits: state.hits } });
          }
          if (String(cmd.input?.Key?.pk || "").startsWith("ratewin#")) {
            return Promise.resolve({ Attributes: { hits: state.winHits } });
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
  }),
  { virtual: true }
);

export const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";
export const rateWrites = () =>
  sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("ratecount#"));
export const windowWrites = () =>
  sends.filter((c) => String(c.input?.Key?.pk || "").startsWith("ratewin#"));

export function siteEvent(path: string, xff?: string) {
  return {
    rawPath: path,
    headers: xff ? { "x-forwarded-for": xff } : {},
    requestContext: { http: { path, sourceIp: "203.0.113.9" } },
  };
}

export function load(env: Record<string, string> = {}) {
  jest.resetModules();
  process.env.APP_STATE_TABLE = "test-app-state";
  delete process.env.appContentDomain;
  delete process.env.APP_CONTENT_DOMAIN;
  delete process.env.FRONTEND_RATE_BLOCK;
  delete process.env.FRONTEND_RATE_LIMIT;
  delete process.env.FRONTEND_RATE_WINDOW_LIMIT;
  delete process.env.FRONTEND_RATE_WINDOW_MINUTES;
  delete process.env.FRONTEND_RATE_WINDOW_BLOCK;
  Object.assign(process.env, env);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../lib/frontend-authorizer/index.js");
}


/** Fresh state before each test: no sends, both counters at 1. */
export function resetState() {
  sends.length = 0;
  state.hits = 1;
  state.winHits = 1;
}

/** The `rate_guard` lines a test's console.warn spy captured. */
export function guardLinesOf(warn: jest.SpyInstance) {
  return warn.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    })
    .filter((l) => l && l.type === "rate_guard");
}
