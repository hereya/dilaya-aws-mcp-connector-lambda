import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// Every instrument the platform has measures a FAILURE. None ever asked: if a
// store is lost or corrupted, can we put it back? For the SQLite databases the
// answer is Litestream, measured on every sweep. For DynamoDB it was, until
// 2026-08-20, "no" — `AppStateTable` (the biggest table on the platform: the
// agent definitions with their hand-written prompts, and the consumption
// ledgers billing reads) had PITR DISABLED and RemovalPolicy DESTROY, while the
// RegistryTable next door — created by our other CDK package, 800 lines away —
// had both. No on-demand backup and no AWS Backup plan existed in the account
// either, so there was no recovery path of any kind.
//
// Asserted here as a POPULATION, in the spirit of core-alarms.test.ts: a table
// added later without a recovery path fails HERE, instead of surfacing in a
// sweep six weeks later.
describe("DynamoDB recoverability posture", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-recover-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
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

  function template(): Template {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("gives EVERY table point-in-time recovery — no exceptions", () => {
    const tables = template().findResources("AWS::DynamoDB::Table");
    const ids = Object.keys(tables);
    expect(ids.length).toBeGreaterThan(0);

    const without = ids.filter(
      (id) =>
        tables[id].Properties?.PointInTimeRecoverySpecification
          ?.PointInTimeRecoveryEnabled !== true
    );
    expect(without).toEqual([]);
  });

  it("retains the state table (agents + billing counters) when the stack goes", () => {
    const tables = template().findResources("AWS::DynamoDB::Table");
    const stateTable = Object.entries(tables).find(([id]) =>
      id.startsWith("AppStateTable")
    );
    expect(stateTable).toBeDefined();

    const [, resource] = stateTable!;
    expect(resource.DeletionPolicy).toBe("Retain");
    expect(resource.UpdateReplacePolicy).toBe("Retain");
  });
});
