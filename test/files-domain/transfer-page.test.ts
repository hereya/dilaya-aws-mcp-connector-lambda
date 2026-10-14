import { createHash } from "crypto";
import { ENABLED, synthWith } from "./helpers";
import { CLOUDFRONT_FUNCTION_MAX_BYTES } from "../../lib/stack/app-content/router-stop-pages";

// The human transfer fallback page (t_dad9f0e09ffb). The function is lifted out
// of the SYNTHESISED template and executed — a string search cannot tell a
// working function from one a stray quote broke.

const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

function synthesised() {
  const t = synthWith(ENABLED);
  const fns = Object.values(t.findResources("AWS::CloudFront::Function")) as any[];
  expect(fns).toHaveLength(1);
  const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0] as any;
  return { t, fn: fns[0], config: dist.Properties.DistributionConfig };
}

const run = (code: string, uri: string) =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(`${code}\nreturn handler;`)()({ request: { uri, method: "GET", headers: {} } });

describe("files transfer page", () => {
  let code: string;
  let fnResource: any;
  let config: any;
  beforeAll(() => {
    const s = synthesised();
    fnResource = s.fn;
    config = s.config;
    code = fnResource.Properties.FunctionCode;
  });

  it("ships as a JS 2.0 function under the edge's 10 KB limit", () => {
    expect(typeof code).toBe("string");
    expect(fnResource.Properties.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    expect(Buffer.byteLength(code, "utf8")).toBeLessThanOrEqual(CLOUDFRONT_FUNCTION_MAX_BYTES);
  });

  it("is bound to /_transfer* on the files distribution, viewer-request, uncached, GET/HEAD only", () => {
    const behaviors = config.CacheBehaviors as any[];
    expect(behaviors).toHaveLength(2);
    const b = behaviors.find((x) => x.PathPattern === "/_transfer*");
    expect(b.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(b.CachePolicyId).toBe(CACHING_DISABLED);
    expect(b.FunctionAssociations).toHaveLength(1);
    expect(b.FunctionAssociations[0].EventType).toBe("viewer-request");
    // The page itself still adds no path to the bucket: it answers from the edge.
    expect(b.TargetOriginId).toBe(config.DefaultCacheBehavior.TargetOriginId);
  });

  // t_transfer_short_link: the short link's id is resolved on the page's OWN
  // origin, so the distribution carries ONE more behavior, POST-capable and
  // uncached, to a SECOND origin — the connector's HTTP API.
  it("proxies exactly /_t to the connector API: a second origin, POST allowed, uncached, no function", () => {
    const b = (config.CacheBehaviors as any[]).find((x) => x.PathPattern === "/_t");
    expect(b).toBeDefined();
    expect(b.AllowedMethods).toContain("POST");
    expect(b.CachePolicyId).toBe(CACHING_DISABLED);
    expect(b.ViewerProtocolPolicy).toBe("https-only");
    expect(b.FunctionAssociations).toBeUndefined();
    expect(b.TargetOriginId).not.toBe(config.DefaultCacheBehavior.TargetOriginId);
    expect(config.Origins).toHaveLength(2);
    const api = (config.Origins as any[]).find((o) => o.Id === b.TargetOriginId);
    // The execute-api host, read off the HTTP API's endpoint (Fn::Select 2 of the split URL).
    expect(JSON.stringify(api.DomainName)).toContain("Fn::Select");
    expect(JSON.stringify(api.DomainName)).toContain("ApiEndpoint");
    expect(api.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
  });

  it("exposes POST /_t on the HTTP API with NO authorizer", () => {
    const { t } = synthesised();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /_t", AuthorizationType: "NONE" });
  });

  it.each(["/_transfer", "/_transfer/"])("answers the page itself on %s", (uri) => {
    const res = run(code, uri);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"].value).toMatch(/^text\/html/);
    expect(res.headers["cache-control"].value).toBe("no-store");
    expect(res.headers["referrer-policy"].value).toBe("no-referrer");
    expect(res.headers["x-frame-options"].value).toBe("DENY");
    expect(res.body).toContain("<main id=m></main><script>");
  });

  it.each(["/_transferX", "/_transfer/other", "/_transfer.html"])("refuses %s with a 404", (uri) => {
    expect(run(code, uri).statusCode).toBe(404);
  });

  it("pins the exact inline script and style in the CSP, and allows nothing else", () => {
    const res = run(code, "/_transfer");
    const csp: string = res.headers["content-security-policy"].value;
    const html: string = res.body;
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1];
    const h = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'sha256-${h(script)}'`);
    expect(csp).toContain(`style-src 'sha256-${h(style)}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe");
  });

  it("carries a script that parses", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(run(code, "/_transfer").body)![1];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(script)).not.toThrow();
  });

  // The script, RUN against a minimal DOM: the two fragment forms take the two
  // paths — a short id is POSTed in the BODY to /_t (never in the URL), the
  // legacy inline JSON renders without any request at all.
  function runPage(hash: string) {
    const script = /<script>([\s\S]*)<\/script>/.exec(run(code, "/_transfer").body)![1];
    const calls: any[] = [];
    const nodes: any[] = [];
    const main = { textContent: "", appendChild: (n: any) => nodes.push(n) };
    const document = {
      getElementById: () => main,
      createElement: (tag: string) => ({ tag, setAttribute(k: string, v: string) { (this as any)[k] = v; } }),
    };
    const fetch = (url: string, init: any) => {
      calls.push({ url, init });
      return new Promise(() => {});
    };
    const sandbox = { document, location: { hash: "#" + hash }, navigator: { language: "fr" }, fetch,
      atob: (b: string) => Buffer.from(b, "base64").toString("binary"), escape: globalThis.escape,
      decodeURIComponent, FormData: class {}, XMLHttpRequest: class {}, Date };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
    return { calls, nodes };
  }

  it("a SHORT fragment is sent in the body of a POST to /_t — never in a path or query", () => {
    const { calls, nodes } = runPage("AbCdEfGhIjKlMnOpQrStUv");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/_t");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(nodes.map((n) => n.textContent)).toContain("Chargement…");
  });

  it("a short fragment that is not an id is refused without any request", () => {
    const { calls, nodes } = runPage("not an id!");
    expect(calls).toHaveLength(0);
    expect(nodes[0].className).toBe("err");
  });

  it("a legacy inline JSON fragment still renders the download button, with no request", () => {
    const payload = { v: 1, op: "download", path: "rapports/a.pdf", exp: Date.now() + 60_000, url: "/p-x/org/rapports/a.pdf?X-Amz-Signature=1" };
    const { calls, nodes } = runPage(Buffer.from(JSON.stringify(payload)).toString("base64url"));
    expect(calls).toHaveLength(0);
    const a = nodes.find((n) => n.tag === "a");
    expect(a.href).toBe(payload.url);
    expect(a.download).toBe("a.pdf");
  });
});

describe("files transfer page absent without filesDomain", () => {
  it("creates no function", () => {
    synthWith({ hereyaProjectEnv: ENABLED.hereyaProjectEnv }).resourceCountIs(
      "AWS::CloudFront::Function",
      0
    );
  });
});
