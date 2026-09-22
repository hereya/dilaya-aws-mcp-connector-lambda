import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// t_appstate_ttl_disabled (22/09/2026): every short-lived row of AppStateTable
// stamps `expires_at` in epoch seconds, and nothing ever read it — TTL was
// never enabled, and the table grew from 259 to 11 760 items in a month, most
// of them dead per-IP rate-guard counters. The attribute name is a contract
// with every writer in the connector AND in the frontend authorizer here.
describe("AppStateTable expires its short-lived rows", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-ttl-"));
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

  it("declares expires_at as the TTL attribute — the name every writer stamps", () => {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const tables = Template.fromStack(stack).findResources("AWS::DynamoDB::Table");
    const appState = Object.entries(tables).find(([id]) => id.startsWith("AppStateTable"));
    expect(appState).toBeDefined();
    expect(appState![1].Properties.TimeToLiveSpecification).toEqual({
      AttributeName: "expires_at",
      Enabled: true,
    });
  });

  it("the frontend authorizer's counters stamp that same attribute, in seconds", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "frontend-authorizer", "index.js"), "utf8");
    const stamps = src.match(/SET expires_at = :e/g) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    const values = src.match(/":e": Math\.floor\(Date\.now\(\) \/ 1000\)/g) ?? [];
    expect(values.length).toBe(stamps.length);
  });
});
