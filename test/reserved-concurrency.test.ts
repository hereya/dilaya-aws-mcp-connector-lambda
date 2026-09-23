import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { reservedConcurrencyFor } from "../lib/stack/reserved-concurrency";

// t_reserved_concurrency (23/09/2026): the connector and its authorizers drew
// from the same unreserved pool as every tenant app backend, so one app's loop
// could throttle /mcp for every org.
describe("the platform's own functions reserve concurrency", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-rc-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function reserved(): Record<string, number | undefined> {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const fns = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    const out: Record<string, number | undefined> = {};
    for (const [id, r] of Object.entries(fns)) out[id] = r.Properties.ReservedConcurrentExecutions;
    return out;
  }
  const pick = (all: Record<string, number | undefined>, prefix: string) =>
    Object.entries(all).find(([id]) => id.startsWith(prefix))?.[1];

  it("connector, MCP authorizer and auth Lambda carry their reservation", () => {
    const all = reserved();
    expect(pick(all, "Handler")).toBe(150);
    expect(pick(all, "AuthorizerHandler")).toBe(50);
    expect(pick(all, "AuthLambdaHandler")).toBe(50);
  });

  it("the reservation leaves AWS's 100-unreserved floor on a 1 000 account", () => {
    const total = Object.values(reserved()).reduce<number>((s, n) => s + (n ?? 0), 0) + 200; // + frontend authorizer (front door)
    expect(1000 - total).toBeGreaterThanOrEqual(100);
  });

  it("a deploy param overrides, 0 / none removes, garbage is refused", () => {
    expect(reservedConcurrencyFor("Handler", { reservedConcurrencyHandler: "200" })).toBe(200);
    expect(reservedConcurrencyFor("Handler", { reservedConcurrencyHandler: "0" })).toBeUndefined();
    expect(reservedConcurrencyFor("Handler", { reservedConcurrencyHandler: "none" })).toBeUndefined();
    expect(() => reservedConcurrencyFor("Handler", { reservedConcurrencyHandler: "-3" })).toThrow();
    expect(reservedConcurrencyFor("Prm", {})).toBeUndefined();
  });
});
