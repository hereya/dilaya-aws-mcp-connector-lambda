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
    expect(behaviors).toHaveLength(1);
    const b = behaviors[0];
    expect(b.PathPattern).toBe("/_transfer*");
    expect(b.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(b.CachePolicyId).toBe(CACHING_DISABLED);
    expect(b.FunctionAssociations).toHaveLength(1);
    expect(b.FunctionAssociations[0].EventType).toBe("viewer-request");
    // Still ONE origin: the page adds no path to the bucket.
    expect(config.Origins).toHaveLength(1);
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
});

describe("files transfer page absent without filesDomain", () => {
  it("creates no function", () => {
    synthWith({ hereyaProjectEnv: ENABLED.hereyaProjectEnv }).resourceCountIs(
      "AWS::CloudFront::Function",
      0
    );
  });
});
