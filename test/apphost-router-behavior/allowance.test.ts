import { makeHandler, req, routerSource, HOST, ORG } from "./helpers";

describe("apphost router", () => {
  // --- over the monthly allowance (t_quota_cut_at_edge) ---------------------
  //
  // The monthly request cap CUT before this — but only in the frontend
  // authorizer, which a cache hit and every path of a static-mode site never
  // reach. So it stopped the cheap tenants and let the expensive ones serve.
  // Same flag, second value.

  it("serves the ALLOWANCE page, not the pause page, when x = 2", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", x: 2 }),
    });
    const out = await handler(req(HOST, "/"));
    expect(out.statusCode).toBe(503);
    expect(out.body).toContain("plafond mensuel");
    // The two causes have different ways out: telling someone over their
    // allowance that their SUBSCRIPTION is paused sends them to a payment page
    // with nothing to fix.
    expect(out.body).not.toContain("en pause");
    expect(out.headers["cache-control"].value).toBe("no-store");
  });

  it("stops a fully STATIC site over its allowance — the case the authorizer cannot see", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", p: ["/"], x: 2 }),
    });
    const out = await handler(req(HOST, "/index.html"));
    expect(out.statusCode).toBe(503);
    expect(out.body).toContain("plafond mensuel");
  });

  it("does not forward a redirect host that is over its allowance", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", r: "www.acme.com", x: 2 }),
    });
    const out = await handler(req(HOST, "/"));
    expect(out.statusCode).toBe(503);
  });

  it("x = 1 still serves the PAUSE page, not the allowance page", async () => {
    const { handler } = makeHandler({
      [HOST]: JSON.stringify({ o: ORG, a: "shop", x: 1 }),
    });
    const out = await handler(req(HOST, "/"));
    expect(out.body).toContain("en pause");
    expect(out.body).not.toContain("plafond mensuel");
  });

  it("neither page can carry a raw apostrophe — it would terminate the emitted JS string", async () => {
    // The generated function body is a single-quoted JS literal produced from a
    // TS template literal. On 2026-08-29 a plain ' inside it was re-emitted raw
    // and broke the function for EVERY tenant site; neither tsc nor synth saw
    // it. Evaluating the function at all is what proves it, and this asserts
    // the property directly so the next page added cannot reintroduce it.
    const src = routerSource();
    // Each page is one single-quoted literal. A raw apostrophe anywhere inside
    // would close it early, so the literal would stop before its own </main>.
    const pages = src.match(/'<!doctype html[^']*'/g) ?? [];
    expect(pages.length).toBe(2);
    for (const page of pages) expect(page).toContain("</main>");
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
