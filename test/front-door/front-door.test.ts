// The FRONT DOOR (t_app_routing_o1, option C, 23/09/2026): five static routes
// integrated to the frontend authorizer's function, which authorizes and then
// invokes the app itself. The contract that matters: an app sees the event its
// literal per-app route used to deliver, and a refusal never reaches it.

jest.mock("@aws-sdk/client-secrets-manager", () => require("../auth-enforce/helpers").secretsManagerMock(), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => require("../auth-enforce/helpers").dynamodbMock(), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => require("../auth-enforce/helpers").ssmMock(), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => require("../auth-enforce/helpers").libDynamodbMock(), { virtual: true });
jest.mock(
  "@aws-sdk/client-lambda",
  () => {
    const g = globalThis as any;
    g.__invokes = g.__invokes || [];
    return {
      LambdaClient: class {
        send(cmd: any) {
          g.__invokes.push(cmd.input);
          return g.__invokeImpl ? g.__invokeImpl(cmd.input) : Promise.resolve({ Payload: Buffer.from('{"statusCode":200,"body":"hi"}') });
        }
      },
      InvokeCommand: class {
        input: any;
        constructor(input: any) {
          this.input = input;
        }
      },
    };
  },
  { virtual: true }
);

import { ORG, load, state, suiteSetup } from "../auth-enforce/helpers";

const g = globalThis as any;
const invokes = (): any[] => g.__invokes || [];
const payload = (i: number) => JSON.parse(Buffer.from(invokes()[i].Payload).toString("utf8"));

function frontEvent(path: string, routeKey: string, headers: Record<string, string> = {}) {
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    headers,
    pathParameters: { orgId: ORG, app: "shop", proxy: "orders/7" },
    requestContext: { routeKey, http: { method: "GET", path, sourceIp: "1.2.3.4" } },
  };
}
const SITE_KEY = "ANY /o/{orgId}/{app}/site/{proxy+}";

describe("front door", () => {
  suiteSetup();
  beforeEach(() => {
    g.__invokes = [];
    g.__invokeImpl = undefined;
    process.env.APP_LAMBDA_NAME_PREFIX = "dilaya-app-";
    process.env.AUTH_FUNCTION_NAME = "AuthLambdaFn";
    state.poolId = null; // auth not enabled: anonymous pass-through
    state.appRow = { lambdaFunctionName: "dilaya-app-88120129-aaaa", stgLambdaFunctionName: "dilaya-app-88120129-aaaa-stg" };
  });

  test("a site request reaches the app's Lambda in the legacy route's shape", async () => {
    const a = load();
    const res = await a.handler(frontEvent(`/o/${ORG}/shop/site/orders/7`, SITE_KEY));
    expect(res).toEqual({ statusCode: 200, body: "hi" });
    expect(invokes()).toHaveLength(1);
    expect(invokes()[0].FunctionName).toBe("dilaya-app-88120129-aaaa");
    const ev = payload(0);
    expect(ev.routeKey).toBe(`ANY /o/${ORG}/shop/site/{proxy+}`);
    expect(ev.requestContext.routeKey).toBe(ev.routeKey);
    expect(ev.pathParameters).toEqual({ proxy: "orders/7" });
    expect(ev.requestContext.authorizer.lambda.authenticated).toBe("false");
    expect(ev.rawPath).toBe(`/o/${ORG}/shop/site/orders/7`);
  });

  test("the site root has the root route's shape: no pathParameters", async () => {
    const a = load();
    await a.handler(frontEvent(`/o/${ORG}/shop/site`, "ANY /o/{orgId}/{app}/site"));
    const ev = payload(0);
    expect(ev.routeKey).toBe(`ANY /o/${ORG}/shop/site`);
    expect(ev.pathParameters).toBeUndefined();
  });

  test("staging goes to the -stg function, the auth tree to the auth Lambda", async () => {
    const a = load();
    await a.handler(frontEvent(`/o/${ORG}/shop/site-stg/x`, "ANY /o/{orgId}/{app}/site-stg/{proxy+}"));
    await a.handler(frontEvent(`/o/${ORG}/shop/auth/login`, "ANY /o/{orgId}/{app}/auth/{proxy+}"));
    expect(invokes().map((i) => i.FunctionName)).toEqual(["dilaya-app-88120129-aaaa-stg", "AuthLambdaFn"]);
  });

  test("a platform-closed site refuses an anonymous visitor with 403 and never wakes the app", async () => {
    const a = load();
    state.appRow = { ...state.appRow, authEnforce: true };
    state.poolId = "eu-west-1_pool";
    const res = await a.handler(frontEvent(`/o/${ORG}/shop/site/orders`, SITE_KEY));
    expect(res.statusCode).toBe(403);
    expect(invokes()).toHaveLength(0);
  });

  test("the origin lock still holds: a direct first-party hit is 403", async () => {
    process.env.appContentDomain = "dilaya-apps.eu";
    const mod = load(); // load() deletes appContentDomain — re-set and reload
    void mod;
    jest.resetModules();
    process.env.appContentDomain = "dilaya-apps.eu";
    const a = require("../../lib/frontend-authorizer/index.js");
    const res = await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY));
    expect(res.statusCode).toBe(403);
    expect(invokes()).toHaveLength(0);
    delete process.env.appContentDomain;
  });

  test("no backend, or a function outside the tenant prefix, is a 404", async () => {
    const a = load();
    state.appRow = {};
    expect((await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY))).statusCode).toBe(404);
    state.appRow = { lambdaFunctionName: "dilaya-connector-Handler" };
    expect((await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY))).statusCode).toBe(404);
    expect(invokes()).toHaveLength(0);
  });

  test("an app that crashes is a 502, an app whose function is gone a 404", async () => {
    const a = load();
    g.__invokeImpl = () => Promise.resolve({ FunctionError: "Unhandled", Payload: Buffer.from("{}") });
    expect((await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY))).statusCode).toBe(502);
    g.__invokeImpl = () => Promise.reject(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    expect((await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY))).statusCode).toBe(404);
  });

  test("a bare value the app returns is relayed verbatim for API Gateway to infer", async () => {
    const a = load();
    g.__invokeImpl = () => Promise.resolve({ Payload: Buffer.from('"plain"') });
    expect(await a.handler(frontEvent(`/o/${ORG}/shop/site/`, SITE_KEY))).toBe("plain");
  });

  test("an authorizer REQUEST event is still answered as an authorizer", async () => {
    const a = load();
    const res = await a.handler({
      type: "REQUEST",
      routeArn: "arn:aws:execute-api:eu-west-1:1:api/$default/GET/x",
      rawPath: `/o/${ORG}/shop/site/x`,
      headers: {},
      requestContext: { routeKey: `ANY /o/${ORG}/shop/site/{proxy+}`, http: { path: "/x", sourceIp: "1.2.3.4" } },
    });
    expect(res.isAuthorized).toBe(true);
    expect(invokes()).toHaveLength(0);
  });
});
