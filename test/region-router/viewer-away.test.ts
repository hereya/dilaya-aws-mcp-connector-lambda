import { useStackFixture } from "../core-alarms/helpers";
import { CA, EU, ORG_CA, ORG_CA2, ORG_EU, ORIGINS, ROUTER_ENV, bearer, makeViewer, viewerCodeFrom, viewerEvent } from "./helpers";

// t_rca_router_cost (29/10/2026): the connector keeps ONE summary key listing the orgs living
// outside HOME (dilaya-connector src/region-router/away.ts), so a bearer costs one KVS read,
// not one per org. The format is the connector's; these tests pin the function's reading of it.
describe("region router: the viewer function reads the summary key once", () => {
  const template = useStackFixture("connector-region-away-", "RegionAwayStack");
  let code: string;
  beforeAll(() => {
    code = viewerCodeFrom(template(ROUTER_ENV));
  });

  /** Runs one request against `kvs`, counting every KVS read. */
  async function run(kvs: Record<string, string>, orgIds: string[], uri?: string) {
    const reads: string[] = [];
    const data = new Proxy(kvs, { has: (t, k) => (reads.push(String(k)), k in t) });
    const { handler, cf } = makeViewer(code, data);
    const req = await handler(viewerEvent({ auth: orgIds.length ? bearer({ org_ids: orgIds }) : undefined, uri }));
    return { reads, origin: cf.origin, route: req.headers["x-dilaya-route"].value, regions: req.headers["x-dilaya-org-regions"]?.value };
  }

  const many = Array.from({ length: 16 }, (_, i) => `${String(i).padStart(8, "0")}-1d2e-4f3a-9b8c-7d6e5f4a3b2c`);

  it("nobody away ('-'): a 16-org bearer costs ONE read and goes home", async () => {
    const r = await run({ __away: "-" }, many);
    expect(r.reads).toEqual(["__away"]);
    expect(r.route).toBe("token");
    expect(r.origin).toBeUndefined();
  });

  it("an away org listed in the summary routes there, still one read", async () => {
    const r = await run({ __away: `${ORG_CA}:${CA}` }, [ORG_CA]);
    expect(r.reads).toEqual(["__away"]);
    expect(r.route).toBe("token");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("orgs across regions: home + the away list for the relay, from the summary alone", async () => {
    const r = await run({ __away: `${ORG_CA}:${CA},${ORG_CA2}:${CA}` }, [ORG_EU, ORG_CA, ORG_CA2]);
    expect(r.reads).toEqual(["__away"]);
    expect(r.route).toBe("body");
    expect(r.origin).toBeUndefined();
    expect(r.regions).toBe(`${ORG_CA}:${CA},${ORG_CA2}:${CA}`);
  });

  it("an org the summary does not list is home, even if a stale per-org key says otherwise", async () => {
    const r = await run({ __away: "-", [ORG_CA]: CA }, [ORG_CA]);
    expect(r.reads).toEqual(["__away"]);
    expect(r.origin).toBeUndefined();
  });

  it("a region with no origin in the summary falls back home", async () => {
    const r = await run({ __away: `${ORG_CA}:ap-south-1` }, [ORG_CA]);
    expect(r.origin).toBeUndefined();
  });

  it("overflow ('*') or no summary (older connector): one read per org, exactly as before", async () => {
    const stores: Record<string, string>[] = [{ __away: "*", [ORG_CA]: CA }, { [ORG_CA]: CA }];
    for (const kvs of stores) {
      const r = await run(kvs, [ORG_CA, ORG_EU]);
      expect(r.reads).toEqual(["__away", ORG_CA, ORG_EU]);
      expect(r.route).toBe("body");
    }
  });

  it("no bearer: no read at all (the scanners hitting /.env cost nothing)", async () => {
    const r = await run({ __away: "-" }, [], "/.env");
    expect(r.reads).toEqual([]);
    expect(r.route).toBe("home");
  });

  it("a path route still reads only the org it names", async () => {
    const r = await run({ __away: "-", [ORG_CA]: CA }, [ORG_EU], `/o/${ORG_CA}/crm/site/`);
    expect(r.reads).toEqual([ORG_CA]);
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
    expect(EU).toBe("eu-west-1");
  });
});
