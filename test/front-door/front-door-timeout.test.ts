// t_front_door_app_timeout (24/09): an app slower than API Gateway's 30 s used
// to outlive the front door itself — the authorizer's sandbox timed out with
// no line naming the app, its Errors alarm fired, the visitor got a mute 503.
// The front door now stops waiting first: a 504 and a line that says which app.

jest.mock(
  "@aws-sdk/client-lambda",
  () => ({
    LambdaClient: class {},
    InvokeCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

const { makeFrontDoor } = require("../../lib/frontend-authorizer/front-door.js");

const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";
const SITE_KEY = "ANY /o/{orgId}/{app}/site/{proxy+}";
const event = {
  version: "2.0",
  routeKey: SITE_KEY,
  rawPath: `/o/${ORG}/shop/site/api/generer`,
  headers: {},
  requestContext: { routeKey: SITE_KEY, http: { method: "POST", path: "/x", sourceIp: "1.2.3.4" } },
};

function door(send: (cmd: any, opts: any) => Promise<any>, appDeadlineMs = 50) {
  return makeFrontDoor({
    authorize: async () => ({ isAuthorized: true, context: {} }),
    appRow: async () => ({ lambdaFunctionName: "dilaya-app-88120129-aaaa" }),
    appFunctionPrefix: "dilaya-app-",
    appDeadlineMs,
    lambda: { send },
  });
}

describe("front door — an app slower than the deadline", () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    jest.spyOn(console, "error").mockImplementation((line: any) => void logged.push(String(line)));
  });
  afterEach(() => jest.restoreAllMocks());

  test("answers 504 before the gateway would, and names the app", async () => {
    const t0 = Date.now();
    const res = await door(() => new Promise(() => {}))(event);
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toEqual({ message: "Gateway Timeout" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    const line = JSON.parse(logged.find((l) => l.includes("front_door_app_timeout"))!);
    expect(line).toMatchObject({ type: "front_door_app_timeout", org: ORG, app: "shop", kind: "site", deadlineMs: 50 });
  });

  test("aborts the SDK call, and the abort error is not reported as an invoke failure", async () => {
    let signal: AbortSignal | undefined;
    const send = (_cmd: any, opts: any) =>
      new Promise((_, reject) => {
        signal = opts?.abortSignal;
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const res = await door(send)(event);
    expect(res.statusCode).toBe(504);
    expect(signal?.aborted).toBe(true);
    expect(logged.some((l) => l.includes("front_door_invoke_failed"))).toBe(false);
  });

  test("an app that answers in time is relayed as before, with no timeout line", async () => {
    const send = () => Promise.resolve({ Payload: Buffer.from('{"statusCode":201,"body":"ok"}') });
    const res = await door(send, 1_000)(event);
    expect(res).toEqual({ statusCode: 201, body: "ok" });
    expect(logged).toEqual([]);
  });

  test("the default deadline leaves margin under API Gateway's 30 s", () => {
    const src = require("fs").readFileSync(require.resolve("../../lib/frontend-authorizer/front-door.js"), "utf8");
    const ms = Number(/const APP_DEADLINE_MS = ([\d_]+);/.exec(src)![1].replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(25_000);
    expect(ms).toBeLessThanOrEqual(29_000);
  });
});
