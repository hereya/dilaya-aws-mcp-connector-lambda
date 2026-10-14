import { makeHandler, req, HOST, ORG } from "./helpers";

// t_login_query_to_fragment (0.1.110). The 0.1.108 fragment only covers the
// 302s the PLATFORM issues (value flag auth). A site closed by its OWN code
// (rap-connect, the legacy enforce:false contract) still redirects an anonymous
// visitor to /auth/login?return_url=<path> — one cache key per probed path, one
// auth-Lambda render each: 48 of its 50 login renders after 0.1.108 went live
// still carried the query, 11 Lambda invocations in the minute of 05:47Z on
// 14/10. No platform code emits that form, and no tenant code can be fixed from
// here, so the EDGE folds it: an anonymous GET/HEAD of /auth/login carrying
// return_url is answered 302 to /auth/login#r=<path> (the other query params
// kept: the OTP page's back link carries ?email=), and the cached page serves.
// The path is filtered to a relative one, exactly as safeReturnUrl would at the
// POST; anything else drops to the bare login page.

const rapConnect = { [HOST]: JSON.stringify({ o: ORG, a: "shop" }) };   // closed by its own code: no auth flag
const platformClosed = { [HOST]: JSON.stringify({ o: ORG, a: "shop", auth: 1 }) };

function login(qs: Record<string, string>, method = "GET", cookie?: string) {
  const r = req(HOST, "/auth/login") as any;
  r.request.method = method;
  r.request.querystring = Object.fromEntries(Object.entries(qs).map(([k, v]) => [k, { value: v }]));
  if (cookie) r.request.cookies = { [cookie]: { value: "x" } };
  return r;
}

describe("apphost router — /auth/login?return_url= folds into the fragment, at the edge", () => {
  it("answers an anonymous GET carrying an ENCODED return_url with a 302 to #r=, on a site closed by its own code", async () => {
    const { handler, cf } = makeHandler(rapConnect);
    const out = await handler(login({ return_url: encodeURIComponent("/orders/42?tab=open") }));
    expect(out.statusCode).toBe(302);
    expect(out.headers.location.value).toBe("/auth/login#r=" + encodeURIComponent("/orders/42?tab=open"));
    expect(out.headers["cache-control"].value).toBe("no-store");
    expect(out.uri).toBeUndefined();
    expect(cf.lastOrigin).toBeUndefined();
  });

  it("accepts a RAW (unencoded) path too — a tenant handler that writes return_url=/x", async () => {
    const { handler } = makeHandler(rapConnect);
    const out = await handler(login({ return_url: "/x" }));
    expect(out.statusCode).toBe(302);
    expect(out.headers.location.value).toBe("/auth/login#r=%2Fx");
  });

  it("every probed path of a scanner lands on the SAME login URL before the fragment — one cache key", async () => {
    const { handler } = makeHandler(rapConnect);
    const targets = new Set<string>();
    for (const p of ["/dashboard", "/form/", "/wrangler.toml", "/values.yaml", "/var/run/secrets/k8s/token"]) {
      const out = await handler(login({ return_url: p }));
      expect(out.statusCode).toBe(302);
      targets.add(out.headers.location.value.split("#")[0]);
    }
    expect([...targets]).toEqual(["/auth/login"]);
  });

  it("does the same on a platform-closed site, and on HEAD (what curl -I sends)", async () => {
    const { handler } = makeHandler(platformClosed);
    expect((await handler(login({ return_url: "/x" }))).headers.location.value).toBe("/auth/login#r=%2Fx");
    expect((await handler(login({ return_url: "/x" }, "HEAD"))).headers.location.value).toBe("/auth/login#r=%2Fx");
  });

  it("keeps the OTHER query params in the query — the OTP page's back link carries ?email=", async () => {
    const { handler } = makeHandler(rapConnect);
    const out = await handler(login({ return_url: "%2Forders", email: "jo%40acme.fr" }));
    expect(out.headers.location.value).toBe("/auth/login?email=jo%40acme.fr#r=%2Forders");
  });

  it("drops a return_url that is not a relative path to the BARE login page (no open redirect, no junk fragment)", async () => {
    const { handler } = makeHandler(rapConnect);
    for (const bad of ["https://evil.com/x", "//evil.com/x", encodeURIComponent("//evil.com"), "\\\\evil.com", "/a\\b", "evil", "", "%E0%A4%A", "/" + "a".repeat(2100)]) {
      const out = await handler(login({ return_url: bad }));
      expect([bad.slice(0, 20), out.statusCode]).toEqual([bad.slice(0, 20), 302]);
      expect(out.headers.location.value).toBe("/auth/login");
    }
  });

  it("touches NOTHING else: a signed-in visitor, a POST, or a login page without return_url all reach the origin as before", async () => {
    const { handler } = makeHandler(rapConnect);
    for (const r of [login({ return_url: "/x" }, "GET", "dilaya_id_token"), login({ return_url: "/x" }, "POST"), login({ email: "a%40b.fr" }), login({})]) {
      const out = await handler(r);
      expect(out.statusCode).toBeUndefined();
      expect(out.uri).toBe(`/o/${ORG}/shop/auth/login`);
    }
    // the querystring object is left as sent (a GET with cookie keeps its return_url for the auth Lambda)
    const kept = login({ return_url: "/x" }, "GET", "dilaya_id_token");
    await handler(kept);
    expect(kept.request.querystring.return_url.value).toBe("/x");
  });
});
