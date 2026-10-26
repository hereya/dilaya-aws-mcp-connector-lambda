import { useStackFixture } from "../core-alarms/helpers";
import { CA, ORG_CA, ORG_EU, ORIGINS, ROUTER_ENV, bearer, makeViewer, viewerCodeFrom, viewerEvent } from "./helpers";

// t_rca_p1_router step 4, gap 2: the public routes that carry NO user bearer and NO /o/<orgId>/
// path used to land on the home pod whatever org they were about. Each names its org another way:
//   /mcp-connections/consent?org=<id>&token=…   the consent link (org in the query)
//   /mcp-connections/events?org=<id>            the channel-events push (connector ≥ the PR that
//                                               adds ?org= to the URL it registers)
//   /mcp-connections/callback?state=<id>.<uuid> the OAuth callback (the state id carries the org)
//   POST /org-events, Bearer <AS assertion>     dilaya.eu's org push: the org is the `org` claim
describe("region router: bearer-less routes reach the pod that owns the org", () => {
  const template = useStackFixture("connector-region-bearerless-", "RegionBearerlessStack");
  let code: string;
  beforeAll(() => {
    code = viewerCodeFrom(template(ROUTER_ENV));
  });

  async function run(ev: ReturnType<typeof viewerEvent>) {
    const { handler, cf } = makeViewer(code);
    const req = await handler(ev);
    return { origin: cf.origin, route: req.headers["x-dilaya-route"]?.value };
  }

  it("the consent link routes on its org query", async () => {
    const r = await run(viewerEvent({ uri: "/mcp-connections/consent", query: { org: ORG_CA, token: "t" } }));
    expect(r.route).toBe("query");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("the channel-events push routes on its org query", async () => {
    const r = await run(viewerEvent({ uri: "/mcp-connections/events", query: { org: ORG_CA } }));
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("the OAuth callback routes on the org prefix of its state", async () => {
    const r = await run(
      viewerEvent({ uri: "/mcp-connections/callback", query: { code: "c", state: `${ORG_CA}.0f1e2d3c-4b5a-4968-8776-655443322110` } })
    );
    expect(r.route).toBe("query");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("a legacy (bare uuid) state, an EU org, garbage → home", async () => {
    for (const query of <Record<string, string>[]>[
      { state: "0f1e2d3c-4b5a-4968-8776-655443322110" },
      { org: ORG_EU },
      { org: "not an org!" },
      { state: "x.y.z" },
    ]) {
      const r = await run(viewerEvent({ uri: "/mcp-connections/callback", query }));
      expect(r.origin).toBeUndefined();
    }
  });

  it("an org query OUTSIDE /mcp-connections/ is not a routing input", async () => {
    const r = await run(viewerEvent({ uri: "/mcp", query: { org: ORG_CA } }));
    expect(r.route).toBe("home");
    expect(r.origin).toBeUndefined();
  });

  it("dilaya.eu's org-events assertion routes on its `org` claim", async () => {
    const r = await run(viewerEvent({ uri: "/org-events", auth: bearer({ iss: "https://dilaya.eu", org: ORG_CA }) }));
    expect(r.route).toBe("token");
    expect(r.origin).toEqual({ domainName: ORIGINS[CA] });
  });

  it("org_ids still win over a stray `org` claim", async () => {
    const r = await run(viewerEvent({ auth: bearer({ org_ids: [ORG_EU], org: ORG_CA }) }));
    expect(r.origin).toBeUndefined();
  });
});
