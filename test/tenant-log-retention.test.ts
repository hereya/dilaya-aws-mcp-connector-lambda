import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// A tenant backend's log group is created by the LAMBDA RUNTIME on first
// invocation, not by this stack — so it is born with AWS's default retention,
// which is "never expire". Every group this stack declares gets 731 days, so
// the gap was invisible to anyone reading the CDK: you have to go and read the
// live account to see it. The 2026-08-22 sweep did, and found all 25 tenant
// groups keeping their lines forever, while the platform's own were capped.
//
// The connector closes it by creating the group itself and stamping an expiry
// on it. That call needs a grant, and the grant is what this file protects: the
// failure mode is silent (the connector swallows AccessDenied so a tenant's log
// hygiene can never break their deploy), so a dropped permission would show up
// as nothing at all — just groups quietly reverting to "never expire".
describe("tenant log-group retention grant", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-log-retention-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  /**
   * Statements from the CONNECTOR handler's own role only.
   *
   * Deliberately not "every policy in the stack": aws-cdk-lib's own
   * `LogRetention` custom resource carries `logs:PutRetentionPolicy` on `"*"`,
   * because at synth time it cannot know which groups it will be asked to
   * configure. That statement is AWS's, it predates this work, and sweeping it
   * into a least-privilege assertion here would fail the test for something we
   * neither wrote nor can scope.
   */
  function handlerStatements(t: Template): Array<{ actions: string[]; resources: unknown }> {
    const out: Array<{ actions: string[]; resources: unknown }> = [];
    for (const [id, policy] of Object.entries(t.findResources("AWS::IAM::Policy")) as any[]) {
      if (!id.startsWith("HandlerServiceRoleDefaultPolicy")) continue;
      for (const s of policy.Properties?.PolicyDocument?.Statement ?? []) {
        out.push({
          actions: Array.isArray(s.Action) ? s.Action : [s.Action],
          resources: s.Resource,
        });
      }
    }
    return out;
  }

  it("grants the connector PutRetentionPolicy on tenant log groups", () => {
    const found = handlerStatements(template()).filter((s) =>
      s.actions.includes("logs:PutRetentionPolicy")
    );
    expect(found.length).toBeGreaterThan(0);
    // It must be able to create the group too — otherwise the retention can only
    // be set AFTER the tenant's first request, leaving an unbounded window.
    expect(
      found.some((s) => s.actions.includes("logs:CreateLogGroup"))
    ).toBe(true);
  });

  it("scopes that grant to the tenant name pattern — never a platform log group", () => {
    const found = handlerStatements(template()).filter((s) =>
      s.actions.includes("logs:PutRetentionPolicy")
    );
    for (const s of found) {
      const rendered = JSON.stringify(s.resources);
      // The tenant prefix is `<orgPrefix>-app-`; the platform's own groups sit
      // under the stack name, so a wildcard on all of /aws/lambda/ would hand
      // the connector power over the very groups that watch it.
      expect(rendered).toContain("-app-");
      expect(rendered).not.toMatch(/log-group:\/aws\/lambda\/\*/);
    }
  });
});
