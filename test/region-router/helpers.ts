import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import { RegionRouterEdgeStack } from "../../lib/stack/region-router/edge-stack";

// The region router's two edge programs are RUN here, not grepped: each is lifted out of a
// synthesized template (the bytes CloudFormation would ship), its runtime ties stubbed, and
// handed real-shaped events. A routing typo is a customer's call answered by the wrong pod.

export const EU = "eu-west-1";
export const CA = "ca-central-1";
export const ORIGINS = { [EU]: "app-eu.dilaya.eu", [CA]: "app-ca.dilaya.eu" };
export const SECRET = "s3cr3t-region-router-0123456789abcdef";

export const ORG_EU = "88120129-295f-476c-b1e1-382ecbc7381a";
export const ORG_CA = "4b0e7f0c-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
export const ORG_CA2 = "0c9b8a7f-6e5d-4c3b-2a19-08f7e6d5c4b3";
export const KVS = { [ORG_EU]: EU, [ORG_CA]: CA, [ORG_CA2]: CA };

/** The pod-stack env that turns the router on (paired with useStackFixture). */
export const ROUTER_ENV = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
  originDomain: "app-eu.dilaya.eu",
  regionRouter: "true",
  regionRouterOrigins: `${EU}:${ORIGINS[EU]},${CA}:${ORIGINS[CA]}`,
  regionRouterCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/rr-1",
  regionRouterOriginSecret: SECRET,
};

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** A bearer with this payload; the signature is junk on purpose — routing never checks it. */
export function bearer(payload: unknown): string {
  return `Bearer ${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.c2ln`;
}

export function viewerCodeFrom(t: Template): string {
  const fns = Object.values(t.findResources("AWS::CloudFront::Function")).filter((r: any) =>
    String(r.Properties?.Name ?? "").endsWith("region-router")
  );
  expect(fns).toHaveLength(1);
  const code = (fns[0] as any).Properties.FunctionCode;
  expect(typeof code).toBe("string");
  return code;
}

/** The shipped viewer function, with only its `cloudfront` import stubbed. */
export function makeViewer(code: string, kvsData: Record<string, string> = KVS) {
  const src = code.replace(/^import cf from 'cloudfront';\s*/m, "");
  expect(src).not.toContain("import ");
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in kvsData)) throw new Error("KeyNotFound");
        return kvsData[key];
      },
    }),
    origin: undefined as unknown,
    updateRequestOrigin(o: unknown) {
      cf.origin = o;
    },
  };
  const handler = new Function("cf", `${src}\nreturn handler;`)(cf) as (e: any) => Promise<any>;
  return { handler, cf };
}

/** A CloudFront Functions viewer-request event. */
export function viewerEvent(opts: {
  host?: string;
  uri?: string;
  auth?: string;
  extra?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const headers: Record<string, { value: string }> = { host: { value: opts.host ?? "app.dilaya.eu" } };
  if (opts.auth) headers.authorization = { value: opts.auth };
  for (const [k, v] of Object.entries(opts.extra ?? {})) headers[k] = { value: v };
  const querystring: Record<string, { value: string }> = {};
  for (const [k, v] of Object.entries(opts.query ?? {})) querystring[k] = { value: v };
  return { request: { method: "POST", uri: opts.uri ?? "/mcp", querystring, headers, cookies: {} } };
}

export function edgeCode(): string {
  const app = new cdk.App();
  const stack = new RegionRouterEdgeStack(app, "RegionRouterEdge", {
    env: { account: "123456789012", region: "us-east-1" },
    origins: ORIGINS,
    home: EU,
  });
  const fns = Object.values(Template.fromStack(stack).findResources("AWS::Lambda::Function")) as any[];
  expect(fns).toHaveLength(1);
  return fns[0].Properties.Code.ZipFile;
}

/** The shipped Lambda@Edge module, evaluated as Node would (CommonJS). */
export function makeEdge(code: string): (e: any) => Promise<any> {
  const mod = { exports: {} as any };
  new Function("module", "exports", "require", "Buffer", code)(mod, mod.exports, require, Buffer);
  return mod.exports.handler;
}

/** An origin-request event as CloudFront builds it, after the viewer function ran. */
export function edgeEvent(opts: {
  route: string;
  regions?: string;
  body?: string | null;
  truncated?: boolean;
  encoding?: "base64" | "text";
}) {
  const headers: Record<string, { key: string; value: string }[]> = {
    host: [{ key: "Host", value: ORIGINS[EU] }],
    "x-dilaya-route": [{ key: "x-dilaya-route", value: opts.route }],
  };
  if (opts.regions !== undefined) headers["x-dilaya-org-regions"] = [{ key: "x-dilaya-org-regions", value: opts.regions }];
  const encoding = opts.encoding ?? "base64";
  const data = opts.body == null ? "" : encoding === "base64" ? Buffer.from(opts.body).toString("base64") : opts.body;
  const request = {
    method: "POST",
    uri: "/mcp",
    querystring: "",
    headers,
    origin: {
      custom: {
        domainName: ORIGINS[EU],
        port: 443,
        protocol: "https",
        path: "",
        customHeaders: { "x-dilaya-region-verify": [{ key: "x-dilaya-region-verify", value: SECRET }] },
      },
    },
    body: { action: "read-only", inputTruncated: Boolean(opts.truncated), encoding, data },
  };
  return { Records: [{ cf: { config: { eventType: "origin-request" }, request } }] };
}

export const toolCall = (org?: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "query", arguments: { ...(org ? { org } : {}), app: "crm", sql: "select 1" } },
});
