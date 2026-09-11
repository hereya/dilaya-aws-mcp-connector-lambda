import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";

// The apphost router runs on EVERY request of EVERY tenant site, and until now
// nothing executed it — the suites around it assert that the synthesised code
// CONTAINS certain strings, which cannot tell a working branch from a typo
// inside one.
//
// So this file runs it. The function source is lifted out of the synthesised
// template, its `import cf from 'cloudfront'` line is replaced by an injected
// stub (the only thing that ties it to the edge runtime), and the result is
// evaluated. Everything below is the REAL shipped code deciding real requests.
//
// It was written for the paused-org branch (t_pause_stops_frontends) but the
// harness is the lasting part: this function reroutes origins, rewrites URIs
// and issues redirects, and a mistake in any of that is a customer's site
// serving the wrong bytes.

export const APP_CONTENT_DOMAIN = "dilaya-apps.eu";

export function routerSource(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-router-"));
  fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "dist", "handler.js"),
    "exports.handler=async()=>({});"
  );
  const saved = { ...process.env };
  process.env.hereyaProjectRootDir = tmpRoot;
  process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
  process.env.hereyaProjectEnv = "{}";
  process.env.customDomain = "app.dilaya.eu";
  process.env.customDomainZone = "dilaya.eu";
  process.env.wildcardCertificateArn =
    "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
  process.env.appContentDomain = APP_CONTENT_DOMAIN;
  process.env.appContentZoneId = "Z0APPCONTENT123";
  process.env.appContentCertArn =
    "arn:aws:acm:us-east-1:123456789012:certificate/abc-123";
  try {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "RouterStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const t = Template.fromStack(stack);
    const fns = Object.values(t.findResources("AWS::CloudFront::Function")).filter(
      (r: any) => String(r.Properties?.Name ?? "").includes("apphost-router")
    );
    expect(fns).toHaveLength(1);
    const code = (fns[0] as any).Properties.FunctionCode;
    if (typeof code === "string") return code;
    const parts = code["Fn::Join"][1] as unknown[];
    // Tokens (the static bucket's regional domain) stand in as a literal — the
    // routing decisions under test never read them.
    return parts
      .map((p) => (typeof p === "string" ? p : "static-bucket.s3.eu-west-1.amazonaws.com"))
      .join("");
  } finally {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

type Kvs = Record<string, string>;

/** The shipped function, with only its edge-runtime import stubbed out. */
export function makeHandler(kvsData: Kvs) {
  const src = routerSource().replace(/^import cf from 'cloudfront';\s*/m, "");
  const cfStub = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in kvsData)) throw new Error("KeyNotFound");
        return kvsData[key];
      },
    }),
    updateRequestOrigin(o: unknown) {
      (this as any).lastOrigin = o;
    },
    lastOrigin: undefined as unknown,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("cf", `${src}\nreturn handler;`);
  return { handler: factory(cfStub) as (e: any) => Promise<any>, cf: cfStub };
}

export const req = (host: string, uri = "/") => ({
  request: { headers: { host: { value: host } }, uri, querystring: {} },
});

export const HOST = `shop--acme.${APP_CONTENT_DOMAIN}`;
export const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";
