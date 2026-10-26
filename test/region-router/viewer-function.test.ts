import { useStackFixture } from "../core-alarms/helpers";
import {
  CA, EU, ORG_CA, ORG_CA2, ORG_EU, ORIGINS, ROUTER_ENV, bearer, makeViewer, viewerCodeFrom, viewerEvent,
} from "./helpers";

// t_rca_p1_router: the viewer-request CloudFront Function, executed on real-shaped events.
describe("region router: the viewer function (token / path → region)", () => {
  const template = useStackFixture("connector-region-viewer-", "RegionViewerStack");
  let code: string;
  beforeAll(() => {
    code = viewerCodeFrom(template(ROUTER_ENV));
  });

  async function run(ev: ReturnType<typeof viewerEvent>, kvs?: Record<string, string>) {
    const { handler, cf } = makeViewer(code, kvs);
    const req = await handler(ev);
    const h = req.headers;
    return { req, h, origin: cf.origin, route: h["x-dilaya-route"]?.value };
  }

  it("a single-org token whose org lives in Montréal goes to the Montréal origin — domain only", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_CA] }) }));
    expect(r.route).toBe("token");
    // Only the domain: the origin's x-dilaya-region-verify header is inherited, not reset.
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("a single-org token in the home region keeps the default (home) origin", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_EU] }) }));
    expect(r.route).toBe("token");
    expect(r.origin).toBeUndefined();
  });

  it("an org the KVS does not know, and the legacy single orgId claim, are routed too", async () => {
    expect((await run(viewerEvent({ auth: bearer({ org_ids: ["unknown-org"] }) }))).origin).toBeUndefined();
    const legacy = await run(viewerEvent({ auth: bearer({ orgId: ORG_CA }) }));
    expect(legacy.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("an EMPTY KVS (the day it is switched on) sends everyone home", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_CA, ORG_EU] }) }), {});
    expect(r.route).toBe("token");
    expect(r.origin).toBeUndefined();
  });

  it("a KVS value naming a region with no origin falls back home", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_CA] }) }), { [ORG_CA]: "ap-south-1" });
    expect(r.origin).toBeUndefined();
  });

  it("a multi-org token all in Montréal still routes on the token (no body needed)", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_CA, ORG_CA2] }) }));
    expect(r.route).toBe("token");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("a multi-org token across regions is left home and handed to the Lambda@Edge with its non-home orgs", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_EU, ORG_CA, ORG_CA2] }) }));
    expect(r.route).toBe("body");
    expect(r.origin).toBeUndefined();
    expect(r.h["x-dilaya-org-regions"].value).toBe(`${ORG_CA}:${CA},${ORG_CA2}:${CA}`);
  });

  it.each([
    ["no Authorization", undefined],
    ["not a bearer", "Basic dXNlcjpwYXNz"],
    ["garbage", "Bearer not.a.jwt!!"],
    ["two segments", "Bearer abc.def"],
    ["payload not JSON", "Bearer eyJhbGciOiJSUzI1NiJ9.bm90IGpzb24.c2ln"],
    ["payload a JSON string", bearer("hello")],
    ["org_ids not an array of ids", bearer({ org_ids: [42, { x: 1 }, "has space", "a".repeat(65)] })],
    ["oversized", "Bearer a." + "b".repeat(20000) + ".c"],
  ])("%s → home, never a throw", async (_label, auth) => {
    const r = await run(viewerEvent({ auth }));
    expect(r.route).toBe("home");
    expect(r.origin).toBeUndefined();
  });

  it("a /o/<orgId>/… path routes on the org it names, whatever the bearer says", async () => {
    const r = await run(viewerEvent({ uri: `/o/${ORG_CA}/crm/telegram/webhook`, auth: bearer({ org_ids: [ORG_EU] }) }));
    expect(r.route).toBe("path");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
    const home = await run(viewerEvent({ uri: `/o/${ORG_EU}/crm/agent/poll` }));
    expect(home.route).toBe("path");
    expect(home.origin).toBeUndefined();
  });

  it("forwards the viewer host (lower-cased) and overwrites what a viewer forged", async () => {
    const r = await run(
      viewerEvent({
        host: "MCP.dilaya.eu",
        uri: "/",
        auth: bearer({ org_ids: [ORG_CA] }),
        extra: {
          "x-dilaya-viewer-host": "evil.example",
          "x-dilaya-route": "body",
          "x-dilaya-org-regions": `${ORG_EU}:${CA}`,
        },
      })
    );
    expect(r.h["x-dilaya-viewer-host"].value).toBe("mcp.dilaya.eu");
    expect(r.route).toBe("token");
    expect(r.h["x-dilaya-org-regions"]).toBeUndefined();
  });

  it("caps the KVS reads of one token at 16 orgs", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `org-${i}`);
    const reads: string[] = [];
    // Every KVS read goes through `key in kvsData` in the stub: count them.
    const spy = makeViewer(code, new Proxy({} as Record<string, string>, {
      has: (_t, k) => (reads.push(String(k)), false),
    }));
    await spy.handler(viewerEvent({ auth: bearer({ org_ids: many }) }));
    expect(reads).toHaveLength(16);
  });

  it("is plain ES5-ish code for the JS 2.0 runtime: no await inside a call argument", () => {
    expect(code).not.toMatch(/\(\s*await\b/);
    expect(code).not.toMatch(/^\s*\/\//m);
    expect(code).toContain(`var HOME = "${EU}"`);
  });
});
