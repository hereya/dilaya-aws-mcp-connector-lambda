import { makeHandler, req, HOST, ORG } from "./helpers";

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
});
