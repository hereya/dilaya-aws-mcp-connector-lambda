import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

export const WIRED = {
  telegramBotTokenParam: "/dilaya/org/apps/app/telegram/credentials",
  telegramChatId: "8592435915",
};

/**
 * The per-describe fixture: a throwaway project root holding a stub
 * `dist/handler.js`, plus the synth entry point. `clearOptionalEnv` reproduces
 * the deletes the core-alarms group does (it asserts the UNWIRED shape too, so
 * an ambient telegram var would make its silence tests lie).
 */
export function useStackFixture(
  prefix: string,
  stackId: string,
  opts: { clearOptionalEnv?: boolean } = {}
) {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

  return function template(env: Record<string, string> = {}): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    if (opts.clearOptionalEnv) {
      delete process.env.customDomain;
      delete process.env.organizationId;
      delete process.env.telegramBotTokenParam;
      delete process.env.telegramChatId;
    }
    Object.assign(process.env, env);
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, stackId, {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  };
}

export function alarmsBy(t: Template, metricName: string) {
  return Object.values(t.findResources("AWS::CloudWatch::Alarm")).filter(
    (r: any) => r.Properties?.MetricName === metricName
  );
}

// The gateway alarm is a metric-math alarm (see the tenant-exclusion tests at
// the bottom of this file), so it carries `Metrics`, not a `MetricName`.
export function mathAlarms(t: Template) {
  return Object.values(t.findResources("AWS::CloudWatch::Alarm")).filter(
    (r: any) => r.Properties?.Metrics?.some((m: any) => m.Expression)
  );
}

export function metricFilterFor(t: Template, metricName: string): any {
  const found = Object.values(
    t.findResources("AWS::Logs::MetricFilter")
  ).filter(
    (r: any) =>
      r.Properties?.MetricTransformations?.[0]?.MetricName === metricName
  );
  expect(found).toHaveLength(1);
  return (found[0] as any).Properties;
}
