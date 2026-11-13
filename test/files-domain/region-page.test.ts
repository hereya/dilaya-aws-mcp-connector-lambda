import { createHash } from "crypto";
import { CLOUDFRONT_FUNCTION_MAX_BYTES } from "../../lib/stack/app-content/router-stop-pages";
import { transferFunctionCode } from "../../lib/stack/files-transfer/page";
import { PAGE_SCRIPT, pageScript } from "../../lib/stack/files-transfer/page-script";
import { MAX_REGIONS } from "../../lib/stack/files-transfer/region-origins";
import { CA, ENABLED, HOME_PREFIX, US, entry, synthWith } from "./helpers";
import { EXPIRED, ID, NETWORK, downloadMaterial, inline, runPage, uploadMaterial } from "./page-harness";

// The transfer page when the files host also fronts other regions (variant
// "probe": the short link keeps its exact form, the page finds the pod).

const pageOf = (overrides: Record<string, string>) => {
  const fns = Object.values(synthWith({ ...ENABLED, ...overrides }).findResources("AWS::CloudFront::Function")) as any[];
  const code: string = fns.map((f) => f.Properties.FunctionCode).find((c) => c.includes("var HTML="));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const res = new Function(`${code}\nreturn handler;`)()({ request: { uri: "/_transfer", method: "GET", headers: {} } });
  return { code, res, script: /<script>([\s\S]*)<\/script>/.exec(res.body)![1]! };
};

describe("transfer page without filesRegionOrigins", () => {
  it("is the single-region script, byte for byte, and knows no regional path", () => {
    expect(pageScript([])).toBe(PAGE_SCRIPT);
    expect(transferFunctionCode([])).toBe(transferFunctionCode());
    const { script, code } = pageOf({});
    expect(script).toBe(PAGE_SCRIPT);
    expect(code).toBe(transferFunctionCode());
    expect(code).not.toContain("/_u");
  });

  it("asks the home pod only, and treats its answers as before", async () => {
    const gone = runPage(PAGE_SCRIPT, ID, { "/_t": 404 });
    await gone.settle();
    expect(gone.fetched.map((f) => f.url)).toEqual(["/_t"]);
    expect(gone.texts()).toEqual([EXPIRED]);
    const down = runPage(PAGE_SCRIPT, ID, { "/_t": 502 });
    await down.settle();
    expect(down.texts()).toEqual([NETWORK]);
    const ok = runPage(PAGE_SCRIPT, ID, { "/_t": 200 }, uploadMaterial("eu-west-1", HOME_PREFIX));
    await ok.settle();
    ok.upload();
    expect(ok.posted).toEqual([{ method: "POST", url: "/" }]);
  });
});

describe("transfer page with filesRegionOrigins (probe)", () => {
  let script: string;
  let res: any;
  beforeAll(() => {
    const p = pageOf({ filesRegionOrigins: `${entry(CA)},${entry(US)}` });
    script = p.script;
    res = p.res;
  });

  it("bakes the regions in the parameter's order, and its CSP pins this exact script", () => {
    expect(script).toContain('var R=["ca-central-1","us-east-2"],U="/";');
    const h = createHash("sha256").update(script, "utf8").digest("base64");
    expect(res.headers["content-security-policy"].value).toContain(`script-src 'sha256-${h}'`);
    expect(res.headers["content-security-policy"].value).toContain("connect-src 'self'");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(script)).not.toThrow();
  });

  it("stays under the function limit with the most regions the parameter accepts", () => {
    const most = Array.from({ length: MAX_REGIONS }, () => "ap-southeast-1");
    const size = Buffer.byteLength(transferFunctionCode(most), "utf8");
    expect(size).toBeLessThanOrEqual(CLOUDFRONT_FUNCTION_MAX_BYTES);
    // Headroom, not a squeeze: the regional page costs well under 1 KB more.
    expect(size - Buffer.byteLength(transferFunctionCode(), "utf8")).toBeLessThan(1024);
  });

  it("a transfer of the home pod: one request, the regions never see the id, the form goes to /", async () => {
    const p = runPage(script, ID, { "/_t": 200 }, uploadMaterial("eu-west-1", HOME_PREFIX));
    await p.settle();
    expect(p.fetched).toEqual([{ url: "/_t", method: "POST", body: ID }]);
    p.upload();
    expect(p.posted).toEqual([{ method: "POST", url: "/" }]);
  });

  it("404 at home, found in the first region: the form goes to /_u/<region>", async () => {
    const p = runPage(script, ID, { "/_t": 404, "/_t/ca-central-1": 200 }, uploadMaterial(CA.region, CA.prefix));
    await p.settle();
    // The id rides in the BODY of every probe, never in a path or query.
    expect(p.fetched).toEqual([
      { url: "/_t", method: "POST", body: ID },
      { url: "/_t/ca-central-1", method: "POST", body: ID },
    ]);
    p.upload();
    expect(p.posted).toEqual([{ method: "POST", url: "/_u/ca-central-1" }]);
  });

  it("found in the SECOND region: probed in order, the form goes to that region", async () => {
    const p = runPage(script, ID, { "/_t": 404, "/_t/ca-central-1": 404, "/_t/us-east-2": 200 }, uploadMaterial(US.region, US.prefix));
    await p.settle();
    expect(p.fetched.map((f) => f.url)).toEqual(["/_t", "/_t/ca-central-1", "/_t/us-east-2"]);
    p.upload();
    expect(p.posted).toEqual([{ method: "POST", url: "/_u/us-east-2" }]);
  });

  it("a region's download follows the signed path it was given — no upload path involved", async () => {
    const material = downloadMaterial(CA.prefix);
    const p = runPage(script, ID, { "/_t": 404, "/_t/ca-central-1": 200 }, material);
    await p.settle();
    expect(p.node("a").href).toBe(material.url);
    expect(p.node("a").href.startsWith(`/${CA.prefix}/`)).toBe(true);
    expect(p.posted).toEqual([]);
  });

  it("404 from EVERY pod, and only then: the link has expired", async () => {
    const p = runPage(script, ID, { "/_t": 404, "/_t/ca-central-1": 404, "/_t/us-east-2": 404 });
    await p.settle();
    expect(p.fetched).toHaveLength(3);
    expect(p.texts()).toEqual([EXPIRED]);
  });

  // A failure is not a "not here". The probe goes on (another pod may hold the
  // id), but without a 2xx the page ends on the retryable message, never on
  // "expired".
  it.each([
    ["home 502, regions 404", { "/_t": 502, "/_t/ca-central-1": 404, "/_t/us-east-2": 404 }],
    ["home unreachable, regions 404", { "/_t": "network", "/_t/ca-central-1": 404, "/_t/us-east-2": 404 }],
    ["home 404, a region 503", { "/_t": 404, "/_t/ca-central-1": 503, "/_t/us-east-2": 404 }],
    ["home 404, a region unreachable", { "/_t": 404, "/_t/ca-central-1": 404, "/_t/us-east-2": "network" }],
    ["home 404, a region 403", { "/_t": 404, "/_t/ca-central-1": 403, "/_t/us-east-2": 404 }],
    ["everything down", { "/_t": "network", "/_t/ca-central-1": "network", "/_t/us-east-2": "network" }],
  ] as const)("%s: a network error, NOT an expired link", async (_name, answers) => {
    const p = runPage(script, ID, answers);
    await p.settle();
    expect(p.fetched).toHaveLength(3);
    expect(p.texts()).toEqual([NETWORK]);
  });

  it("a pod that is down does not hide a transfer another pod holds", async () => {
    const p = runPage(script, ID, { "/_t": 502, "/_t/ca-central-1": 200 }, uploadMaterial(CA.region, CA.prefix));
    await p.settle();
    expect(p.fetched.map((f) => f.url)).toEqual(["/_t", "/_t/ca-central-1"]);
    p.upload();
    expect(p.posted).toEqual([{ method: "POST", url: "/_u/ca-central-1" }]);
  });

  it("a 2xx that is not the material is a network error, as before", async () => {
    const p = runPage(script, ID, { "/_t": 404, "/_t/ca-central-1": 200 }, { nope: true });
    await p.settle();
    expect(p.texts()).not.toEqual([EXPIRED]);
    expect(p.posted).toEqual([]);
  });

  it("still refuses a fragment that is not an id without any request", () => {
    const p = runPage(script, "not an id!");
    expect(p.fetched).toEqual([]);
    expect(p.node("p").className).toBe("err");
  });

  // A legacy INLINE fragment carries its material: nothing is probed. The
  // region of an upload is read from the signed form's credential scope.
  it.each([
    ["a baked region", CA.region, "/_u/ca-central-1"],
    ["the home region", "eu-west-1", "/"],
    ["a region the page does not know", "ap-south-1", "/"],
  ])("inline upload fragment signed in %s posts to the right place", (_name, region, url) => {
    const p = runPage(script, inline(uploadMaterial(region, "p-any")));
    expect(p.fetched).toEqual([]);
    p.upload();
    expect(p.posted).toEqual([{ method: "POST", url }]);
  });

  it("an inline download fragment renders with no request", () => {
    const material = downloadMaterial(CA.prefix);
    const p = runPage(script, inline(material));
    expect(p.fetched).toEqual([]);
    expect(p.node("a").href).toBe(material.url);
  });
});
