import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

export const PKG_ROOT = path.join(__dirname, "..", "..");
export const FILES_DOMAIN = "files.dilaya.eu";
export const FILES_ZONE_ID = "Z0FILESZONE123";
export const FILES_CERT_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/files-cert";
export const BUCKET = "platform-p-files-test";

/** The three inputs plus the file-storage output they front. */
export const ENABLED: Record<string, string> = {
  hereyaProjectEnv: JSON.stringify({ bucketName: BUCKET, s3Prefix: "p-x" }),
  filesDomain: FILES_DOMAIN,
  filesZoneId: FILES_ZONE_ID,
  filesCertArn: FILES_CERT_ARN,
};

const FEATURE_KEYS = ["filesDomain", "filesZoneId", "filesCertArn"];

/**
 * Synthesize the stack under a minimal env (no customDomain, no app-content)
 * plus `overrides`; an `undefined` override removes the key. The env is
 * restored before returning, so suites cannot leak into each other.
 */
export function synthWith(overrides: Record<string, string | undefined>): Template {
  const saved = { ...process.env };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-files-"));
  fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "dist", "handler.js"),
    "exports.handler=async()=>({});"
  );
  try {
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    for (const k of ["customDomain", "appContentDomain", "organizationId", ...FEATURE_KEYS]) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "FilesDomainStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  } finally {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Every .ts under lib/, so a guard survives the next file split. */
export function readLibSources(dir = path.join(PKG_ROOT, "lib")): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return readLibSources(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")
        ? fs.readFileSync(p, "utf8")
        : "";
    })
    .join("\n");
}
