import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

/** The package root, seen from test/alarm-relay/. */
export const PKG_ROOT = path.join(__dirname, "..", "..");

/** Every TypeScript source under lib/, concatenated. */
export function readLibSources(): string {
  const root = path.join(PKG_ROOT, "lib");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  if (!out.length) throw new Error(`no sources found under ${root}`);
  return out.join("\n");
}

export const BOTH = {
  telegramBotTokenParam: "/dilaya/org/apps/app/telegram/credentials",
  telegramChatId: "8592435915",
};

// --- Waking the ops agent (2026-08-25) ------------------------------------
// The wake is wired ONLY when both inputs are present. Half-configured must
// stay OFF rather than half-on: an undeclared/absent package parameter is
// dropped in silence while the deploy still goes green (three wasted
// releases, 2026-08-07), and the connector refuses an alarm envelope rather
// than defaulting — so a partial wiring would fail on every alarm instead.
export const INBOX = {
  alarmInboxOrg: "88120129-295f-476c-b1e1-382ecbc7381a",
  alarmInboxApp: "dilayadev",
};

/**
 * Registers the beforeAll/afterAll pair that gives the stack a throwaway
 * project root, and returns the `template(env)` builder the suites share.
 * Call it from inside the describe body that needs it.
 */
export function setupTemplateHarness(): {
  template: (env: Record<string, string | undefined>) => Template;
} {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-alarm-relay-"));
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

  function template(env: Record<string, string | undefined>): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
    delete process.env.alarmInboxOrg;
    delete process.env.alarmInboxApp;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  return { template };
}

export function relayEnv(t: Template): Record<string, unknown> {
  const fns = t.findResources("AWS::Lambda::Function", {
    Properties: { Environment: { Variables: { TELEGRAM_CHAT_ID: Match.anyValue() } } },
  });
  expect(Object.keys(fns)).toHaveLength(1);
  return Object.values(fns)[0].Properties.Environment.Variables;
}
