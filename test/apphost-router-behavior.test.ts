import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

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

const APP_CONTENT_DOMAIN = "dilaya-apps.eu";

function routerSource(): string {
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
function makeHandler(kvsData: Kvs) {
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

const req = (host: string, uri = "/") => ({
  request: { headers: { host: { value: host } }, uri, querystring: {} },
});

const HOST = `shop--acme.${APP_CONTENT_DOMAIN}`;
const ORG = "88120129-295f-476c-b1e1-382ecbc7381a";

describe("apphost router", () => {
  it("routes a known dynamic host to its app's site path", async () => {
    const { handler } = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop" }) });
    const out = await handler(req(HOST, "/e/foo"));
    expect(out.uri).toBe(`/o/${ORG}/shop/site/e/foo`);
    expect(out.headers["x-dilaya-app-host"].value).toBe(HOST);
  });

  it("passes an unknown host straight through, to 404 at the origin", async () => {
    const { handler } = makeHandler({});
    const out = await handler(req("nobody.example.com", "/x"));
    expect(out.uri).toBe("/x");
    expect(out.statusCode).toBeUndefined();
  });

  // --- paused org (t_pause_stops_frontends) ---------------------------------
  //
  // Jonatan, 2026-08-29: "est ce que la pause d'une org met en pause aussi les
  // apps y compris les frontends?" — then, five seconds later, "il le faut."
  // Until this branch, pausing an org cut Claude's tools and outbound mail and
  // left every customer site serving, for ever.

  it("serves a paused page instead of the site when the org is paused", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", x: 1 }),
    });
    const out = await handler(req(HOST, "/"));
    expect(out.statusCode).toBe(503);
    expect(out.headers["cache-control"].value).toBe("no-store");
    expect(out.body).toContain("en pause");
    // Whatever else it did, it did not route the request onward.
    expect(out.uri).toBeUndefined();
  });

  // The gate has to sit at the EDGE, not in the authorizer: a static-mode site
  // never reaches the authorizer at all, so an authorizer-only gate would pause
  // precisely the orgs whose sites cost us least and leave the rest online.
  it("pauses a STATIC-mode site too — the case an authorizer gate would miss", async () => {
    const { handler, cf } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", p: ["/"], x: 1 }),
    });
    const out = await handler(req(HOST, "/about"));
    expect(out.statusCode).toBe(503);
    expect(cf.lastOrigin).toBeUndefined();
  });

  // A paused space does not forward visitors either.
  it("pauses BEFORE honouring a canonical redirect", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", r: "www.acme.com", x: 1 }),
    });
    expect((await handler(req(HOST, "/"))).statusCode).toBe(503);
  });

  it("an org that is NOT paused is untouched by the branch", async () => {
    const { handler } = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop" }) });
    const out = await handler(req(HOST, "/"));
    expect(out.statusCode).toBeUndefined();
    expect(out.uri).toBe(`/o/${ORG}/shop/site/`);
  });

  // /static/* is served from S3 by its own cache behavior. It must pause too,
  // and it is the path most likely to be forgotten because it returns before
  // most of the function's body runs.
  it("pauses /static/* as well", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", x: 1 }),
    });
    expect((await handler(req(HOST, "/static/app.css"))).statusCode).toBe(503);
  });
});
