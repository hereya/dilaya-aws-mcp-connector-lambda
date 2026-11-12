// The cold-start step line (lib/frontend-authorizer/cold-timing.js).
//
// A sandbox's first invocation is far slower than its module load explains,
// and the REPORT line only gives a total. One `cold_start_steps` line says
// where that first invocation spent its time. It sits on the path of every
// tenant site, so the properties held here are the ones that make it safe to
// have there: it never changes an answer, never speaks twice, never says whose
// request it timed, and a broken timer is a missing line — nothing more.

jest.mock("@aws-sdk/client-secrets-manager", () => require("./auth-enforce/helpers").secretsManagerMock(), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => require("./auth-enforce/helpers").dynamodbMock(), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => require("./auth-enforce/helpers").ssmMock(), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => require("./auth-enforce/helpers").libDynamodbMock(), { virtual: true });
jest.mock(
  "@aws-sdk/client-lambda",
  () => ({
    LambdaClient: class {
      send() {
        return Promise.resolve({ Payload: Buffer.from('{"statusCode":200,"body":"hi"}') });
      }
    },
    InvokeCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

import { ORG, event, load, state, suiteSetup } from "./auth-enforce/helpers";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makeColdTimer } = require("../lib/frontend-authorizer/cold-timing.js");

const SITE = `/o/${ORG}/shop/site/orders/7`;
const frontEvent = () => ({
  version: "2.0",
  routeKey: "ANY /o/{orgId}/{app}/site/{proxy+}",
  rawPath: SITE,
  headers: {},
  requestContext: { routeKey: "ANY /o/{orgId}/{app}/site/{proxy+}", http: { method: "GET", path: SITE, sourceIp: "1.2.3.4" } },
});

describe("cold-start step timer (unit)", () => {
  function fixture() {
    let t = 1000;
    const lines: string[] = [];
    const timer = makeColdTimer({ now: () => t, log: (l: string) => lines.push(l) });
    return { timer, lines, tick: (ms: number) => (t += ms) };
  }

  test("a step is the time since the previous mark, and the steps add up to the total", () => {
    const { timer, lines, tick } = fixture();
    timer.begin();
    tick(40);
    timer.mark("a");
    tick(300);
    timer.mark("b");
    tick(5);
    timer.mark("a"); // the same step twice accumulates (a retry loop)
    timer.end("authorizer");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "cold_start_steps",
      kind: "authorizer",
      total_ms: 345,
      steps: { a: 45, b: 300 },
    });
  });

  test("only the FIRST invocation of a sandbox is timed: afterwards it is silent for good", () => {
    const { timer, lines, tick } = fixture();
    timer.begin();
    timer.end("authorizer");
    for (let i = 0; i < 3; i++) {
      timer.begin();
      tick(10);
      timer.mark("a");
      timer.end("authorizer");
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).steps).toEqual({});
  });

  test("a mark or an end before any begin does nothing", () => {
    const { timer, lines } = fixture();
    timer.mark("a");
    timer.end("authorizer");
    expect(lines).toHaveLength(0);
  });

  test("a broken clock or a broken log never throws", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const noClock = makeColdTimer({ now: boom, log: () => {} });
    expect(() => {
      noClock.begin();
      noClock.mark("a");
      noClock.end("authorizer");
    }).not.toThrow();
    const noLog = makeColdTimer({ now: () => 1, log: boom });
    expect(() => {
      noLog.begin();
      noLog.mark("a");
      noLog.end("authorizer");
    }).not.toThrow();
  });
});

describe("cold-start step line (through the handler)", () => {
  suiteSetup();
  const coldLines = () =>
    (console.log as jest.Mock).mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.type === "cold_start_steps");

  beforeEach(() => {
    process.env.APP_LAMBDA_NAME_PREFIX = "dilaya-app-";
    state.poolId = null; // auth not enabled: anonymous pass-through
    state.appRow = { lambdaFunctionName: "dilaya-app-fn" };
  });

  test("the first invocation writes ONE line naming the steps it went through", async () => {
    const a = load();
    await a.handler(event(SITE));
    const lines = coldLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("authorizer");
    expect(typeof lines[0].total_ms).toBe("number");
    expect(Object.keys(lines[0].steps)).toEqual([
      "origin_lock",
      "monthly_cap",
      "rate_guards",
      "registry",
      "capability_secret",
      "data_api",
      "auth_config",
      "count_settle",
    ]);
    for (const ms of Object.values(lines[0].steps)) expect(typeof ms).toBe("number");
  });

  test("a warm invocation writes nothing", async () => {
    const a = load();
    await a.handler(event(SITE));
    await a.handler(event(SITE));
    await a.handler(frontEvent());
    expect(coldLines()).toHaveLength(1);
  });

  test("the line says nothing about whose request it was", async () => {
    const a = load();
    await a.handler(event(SITE));
    const raw = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.includes("cold_start_steps"))!;
    expect(raw).not.toContain(ORG);
    expect(raw).not.toContain("shop");
    expect(raw).not.toContain("orders");
    expect(raw).not.toContain("1.2.3.4");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["kind", "steps", "total_ms", "type"]);
  });

  test("through the front door it also times the SDK load and the app's own answer", async () => {
    const a = load();
    const res = await a.handler(frontEvent());
    expect(res).toEqual({ statusCode: 200, body: "hi" });
    const lines = coldLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("front_door");
    expect(Object.keys(lines[0].steps)).toEqual(expect.arrayContaining(["app_row", "lambda_sdk_load", "app_invoke"]));
  });

  test("the answer is the same cold and warm, on every kind of verdict", async () => {
    // anonymous pass-through, platform-closed refusal, registry down
    const cases: Array<() => void> = [
      () => {},
      () => {
        state.appRow = { authEnforce: true };
        state.poolId = "eu-west-1_pool";
      },
      () => {
        state.registryThrows = true;
      },
    ];
    for (const arrange of cases) {
      const a = load();
      arrange();
      const coldAnswer = await a.handler(event(SITE));
      const warmAnswer = await a.handler(event(SITE));
      expect(coldAnswer).toEqual(warmAnswer);
      state.registryThrows = false;
    }
  });

  test("a log that throws costs the line, never the answer", async () => {
    const a = load();
    const warm = await (async () => {
      const b = load();
      await b.handler(event(SITE));
      return b.handler(event(SITE));
    })();
    (console.log as jest.Mock).mockImplementation(() => {
      throw new Error("stdout gone");
    });
    await expect(a.handler(event(SITE))).resolves.toEqual(warm);
  });

});
