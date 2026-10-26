import { makeHandler, req, routerSource, HOST, ORG } from "./helpers";
import { parseRegionOrigins } from "../../lib/stack/app-content/router-region";

// t_rca_p1_router step 4, gap 1: a host whose org lives in another region carries `g` in its KVS
// value (dilaya-connector kvs-region.ts). The router must serve it from THAT region's pod and
// bucket — never from the home ones — and refuse a region it has no origin for.
const CA = "ca-central-1";
const CA_HOST = "app-ca.dilaya.eu";
const CA_BUCKET = "dilaya-ca-static.s3.ca-central-1.amazonaws.com";
const ENV = { appContentRegionOrigins: `${CA}:${CA_HOST}:${CA_BUCKET}` };
const caEntry = (extra: object = {}) => JSON.stringify({ o: ORG, a: "shop", g: CA, ...extra });

describe("apphost router: the region of the org (g)", () => {
  it("a dynamic page of a Montréal site goes to the Montréal pod — domain only, lock header inherited", async () => {
    const { handler, cf } = makeHandler({ [HOST]: caEntry() }, ENV);
    const out = await handler(req(HOST, "/e/foo"));
    expect(out.uri).toBe(`/o/${ORG}/shop/site/e/foo`);
    expect(cf.lastOrigin).toEqual({ domainName: CA_HOST });
  });

  it("/auth/* of a Montréal site goes to the Montréal pod too", async () => {
    const { handler, cf } = makeHandler({ [HOST]: caEntry() }, ENV);
    await handler(req(HOST, "/auth/login"));
    expect(cf.lastOrigin).toEqual({ domainName: CA_HOST });
  });

  it("/static/* of a Montréal site is read from the Montréal bucket, OAC-signed", async () => {
    const { handler, cf } = makeHandler({ [HOST]: caEntry() }, ENV);
    const out = await handler(req(HOST, "/static/app.css"));
    expect(out.uri).toBe(`/_appstatic/${ORG}/shop/app.css`);
    expect((cf.lastOrigin as any).domainName).toBe(CA_BUCKET);
    expect((cf.lastOrigin as any).originAccessControlConfig.enabled).toBe(true);
    expect((cf.lastOrigin as any).customHeaders).toEqual({});
  });

  it("a static section of a Montréal site is read from the Montréal bucket", async () => {
    const { handler, cf } = makeHandler({ [HOST]: caEntry({ p: ["/"] }) }, ENV);
    const out = await handler(req(HOST, "/index.html"));
    expect(out.uri).toBe(`/_appsite/${ORG}/shop/index.html`);
    expect((cf.lastOrigin as any).domainName).toBe(CA_BUCKET);
  });

  it("a home host (no g) is untouched: home bucket, home origin", async () => {
    const { handler, cf } = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop", p: ["/"] }) }, ENV);
    await handler(req(HOST, "/index.html"));
    expect((cf.lastOrigin as any).domainName).toBe("static-bucket.s3.eu-west-1.amazonaws.com");
    const dyn = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop" }) }, ENV);
    await dyn.handler(req(HOST, "/"));
    expect(dyn.cf.lastOrigin).toBeUndefined();
  });

  it("a region the router has no origin for is 503 at the edge, never served from home", async () => {
    const { handler, cf } = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop", g: "ap-south-1" }) }, ENV);
    const out = await handler(req(HOST, "/"));
    expect(out.statusCode).toBe(503);
    expect(cf.lastOrigin).toBeUndefined();
  });

  it("a paused Montréal site still answers the pause page (the stop flag comes first)", async () => {
    const { handler } = makeHandler({ [HOST]: caEntry({ x: 1 }) }, ENV);
    expect((await handler(req(HOST, "/"))).statusCode).toBe(503);
  });

  it("without the parameter the shipped function is exactly what it was", () => {
    const src = routerSource();
    expect(src).not.toContain("REGIONS");
    expect(src).not.toContain("toBucket");
  });

  it("stays under the 10 KB edge budget with the branch on", () => {
    const code = routerSource(ENV).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(Buffer.byteLength(code, "utf8")).toBeLessThan(10 * 1024);
  });

  it("parses and validates the parameter", () => {
    expect(parseRegionOrigins(undefined, "eu-west-1")).toBeUndefined();
    expect(parseRegionOrigins(ENV.appContentRegionOrigins, "eu-west-1")).toEqual({ [CA]: { h: CA_HOST, b: CA_BUCKET } });
    for (const bad of [
      "ca-central-1:app-ca.dilaya.eu",
      `ca-central-1:app-ca.dilaya.eu:b.s3.eu-west-1.amazonaws.com`,
      `eu-west-1:app-eu.dilaya.eu:b.s3.eu-west-1.amazonaws.com`,
      `${ENV.appContentRegionOrigins},${ENV.appContentRegionOrigins}`,
      "nowhere:app-ca.dilaya.eu:b.s3.ca-central-1.amazonaws.com",
    ]) {
      expect(() => parseRegionOrigins(bad, "eu-west-1")).toThrow(/appContentRegionOrigins/);
    }
  });
});
