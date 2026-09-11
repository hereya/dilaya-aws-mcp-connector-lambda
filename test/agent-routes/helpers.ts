import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

/**
 * Shared synth harness for the agent-routes suites: a throwaway project root
 * holding a stub dist/handler.js, the minimal env each suite needs, and a
 * template() factory that synths the connector stack. Registers the suite's
 * beforeAll/afterAll, so call it from inside the describe body.
 */
export function useConnectorTemplate(opts: {
  tmpPrefix: string;
  stackId: string;
  projectEnv: string;
}): () => Template {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = opts.projectEnv;
    delete process.env.customDomain;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  return function template(): Template {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, opts.stackId, {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  };
}
