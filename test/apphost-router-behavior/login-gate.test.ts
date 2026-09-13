import { makeHandler, req, routerSource, HOST, ORG } from "./helpers";

// LOGIN REQUIRED at the edge (t_frontend_auth_default, deploy-pkg 0.1.73).
//
// Jonatan, 2026-09-13: « il faut que dans la création des apps avec frontend
// l'authentification soit le default sauf si c'est explicitement mis public ».
// Found the same evening: a customer's site was public although Claude had
// answered "it is protected now" — enable-auth installed the login page but
// closing the site was the app's own job, and that app never did it. Shape A,
// chosen by button: the PLATFORM closes. This branch is the half that a
// static-mode site can only get here (S3 never reaches the authorizer), and
// the saving for dynamic ones (no Lambda for an anonymous hit).

const entry = (extra: Record<string, unknown> = {}) => ({
  [HOST]: JSON.stringify({ o: ORG, a: "shop", auth: 1, ...extra }),
});
const withCookie = (host: string, uri: string, name = "dilaya_id_token") => {
  const r = req(host, uri) as any;
  r.request.cookies = { [name]: { value: "x" } };
  return r;
};

describe("apphost router — login gate", () => {
  it("sends a cookie-less visitor of an enforced site to /auth/login, keeping where they were", async () => {
    const { handler, cf } = makeHandler(entry());
    const r = req(HOST, "/orders/42") as any;
    r.request.querystring = { tab: { value: "open" } };
    const out = await handler(r);
    expect(out.statusCode).toBe(302);
    expect(out.headers.location.value).toBe("/auth/login?return_url=" + encodeURIComponent("/orders/42?tab=open"));
    expect(out.headers["cache-control"].value).toBe("no-store");
    expect(out.uri).toBeUndefined();
    expect(cf.lastOrigin).toBeUndefined();
  });

  it("answers /api/* with 401 JSON instead — an XHR has nowhere to be redirected to", async () => {
    const { handler } = makeHandler(entry());
    const out = await handler(req(HOST, "/api/orders"));
    expect(out.statusCode).toBe(401);
    expect(out.headers["content-type"].value).toContain("application/json");
    expect(JSON.parse(out.body)).toEqual({ error: "login_required" });
  });

  it("lets a visitor WITH a session cookie through to the origin, untouched", async () => {
    const { handler } = makeHandler(entry());
    for (const name of ["dilaya_id_token", "hereya_id_token", "dilaya_agent"]) {
      const out = await handler(withCookie(HOST, "/orders/42", name));
      expect(out.statusCode).toBeUndefined();
      expect(out.uri).toBe(`/o/${ORG}/shop/site/orders/42`);
    }
  });

  // The login flow itself, and the assets the login page needs (its logo).
  it("never gates /auth/* nor /static/*", async () => {
    const { handler } = makeHandler(entry());
    expect((await handler(req(HOST, "/auth/login"))).uri).toBe(`/o/${ORG}/shop/auth/login`);
    expect((await handler(req(HOST, "/static/logo.png"))).uri).toBe(`/_appstatic/${ORG}/shop/logo.png`);
  });

  it("honours the app's declared public prefixes — '/' means the root page only", async () => {
    const { handler } = makeHandler(entry({ pub: ["/menu", "/"] }));
    expect((await handler(req(HOST, "/menu"))).statusCode).toBeUndefined();
    expect((await handler(req(HOST, "/menu/today"))).statusCode).toBeUndefined();
    expect((await handler(req(HOST, "/"))).statusCode).toBeUndefined();
    expect((await handler(req(HOST, "/menus"))).statusCode).toBe(302);
    expect((await handler(req(HOST, "/admin"))).statusCode).toBe(302);
  });

  // The whole point of gating at the edge: a static section is served from
  // S3 and never reaches the frontend authorizer.
  it("gates a STATIC section before the origin swap", async () => {
    const { handler, cf } = makeHandler(entry({ p: ["/"] }));
    const out = await handler(req(HOST, "/about"));
    expect(out.statusCode).toBe(302);
    expect(cf.lastOrigin).toBeUndefined();
    const ok = await handler(withCookie(HOST, "/about"));
    expect(ok.uri).toBe(`/_appsite/${ORG}/shop/index.html`); // no route key → the section index (SPA fallback)
    expect(cf.lastOrigin).toBeDefined();
  });

  it("changes nothing for an entry without the flag (every pre-0.1.73 app)", async () => {
    const { handler } = makeHandler({ [HOST]: JSON.stringify({ o: ORG, a: "shop" }) });
    const out = await handler(req(HOST, "/orders/42"));
    expect(out.statusCode).toBeUndefined();
    expect(out.uri).toBe(`/o/${ORG}/shop/site/orders/42`);
  });

  it("a stopped site stops BEFORE it asks anyone to log in", async () => {
    const { handler } = makeHandler(entry({ x: 1 }));
    expect((await handler(req(HOST, "/"))).statusCode).toBe(503);
  });

  it("a canonical redirect wins over the gate (the target host will gate)", async () => {
    const { handler } = makeHandler(entry({ r: "www.shop.example" }));
    expect((await handler(req(HOST, "/x"))).statusCode).toBe(301);
  });
});

describe("apphost router — code budget", () => {
  // CloudFront Functions are refused above 10 KB. The source is ~9.2 KB WITH
  // its comments; they are stripped at synth, and this is the line that says
  // so — the only symptom of crossing it is a failed deploy.
  it("ships under the CloudFront 10 KB limit, comments stripped", () => {
    const code = routerSource();
    expect(Buffer.byteLength(code, "utf8")).toBeLessThanOrEqual(10 * 1024);
    expect(code).not.toMatch(/^\s*\/\//m);
    // The stripped source still carries every branch.
    for (const s of ["if (e.x)", "if (e.r)", "if (e.auth", "if (e.p && e.p.length", "if (e.e === 's')"]) {
      expect(code).toContain(s);
    }
  });
});
