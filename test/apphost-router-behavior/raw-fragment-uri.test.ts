import { makeHandler, req, HOST, ORG } from "./helpers";

// A client that sends its FRAGMENT on the wire — `GET /auth/login#r=%2F HTTP/1.1`,
// a bot replaying the platform's own login 302 verbatim — hands the function a
// RAW '#' in request.uri (the edge access log writes it as %23, the way it
// percent-encodes every '#' and '%'). CloudFront accepts that uri IN, but the
// router rewrote it to /o/<org>/<app>/auth/login#r=%2F, and CloudFront refuses a
// RETURNED uri carrying '#': 502, x-edge-result-type FunctionValidationError,
// x-edge-detailed-result-type InvalidUri. Reproduced on a live host with a raw
// request line; the same client without the fragment gets the login page.
//
// The router now drops everything from the first raw '#' before any branch
// reads or rewrites uri. A percent-encoded %23 / %2523 is a real path byte and
// stays untouched (the origin answers it, 404 for a login path).

const open = { [HOST]: JSON.stringify({ o: ORG, a: "shop" }) };
const closed = { [HOST]: JSON.stringify({ o: ORG, a: "shop", auth: 1, pub: ["/"] }) };
const staticSite = { [HOST]: JSON.stringify({ o: ORG, a: "shop", p: ["/"] }) };

// What CloudFront accepts back: starts with '/', printable ASCII, no raw '#'.
function expectValidUri(uri: string) {
  expect(uri.charAt(0)).toBe("/");
  expect(uri).toMatch(/^[\x21-\x7e]+$/);
  expect(uri).not.toContain("#");
}

describe("apphost router — a raw '#' in the request uri", () => {
  it("drops the fragment of /auth/login#r=… and routes the bare login page", async () => {
    for (const site of [open, closed]) {
      const { handler } = makeHandler(site);
      for (const uri of ["/auth/login#r=%2F", "/auth/login#r=/", "/auth/login#"]) {
        const out = await handler(req(HOST, uri));
        expect(out.statusCode).toBeUndefined();
        expect(out.uri).toBe(`/o/${ORG}/shop/auth/login`);
        expectValidUri(out.uri);
      }
    }
  });

  it("drops it on a site path and a static section too", async () => {
    const dyn = await makeHandler(open).handler(req(HOST, "/orders/42#tab"));
    expect(dyn.uri).toBe(`/o/${ORG}/shop/site/orders/42`);
    const st = await makeHandler(staticSite).handler(req(HOST, "/about#team"));
    expectValidUri(st.uri);
    expect(st.uri).toBe(`/_appsite/${ORG}/shop/index.html`);
  });

  it("a closed site's login redirect no longer carries the fragment into r=", async () => {
    const out = await makeHandler(closed).handler(req(HOST, "/orders#x"));
    expect(out.statusCode).toBe(302);
    expect(out.headers.location.value).toBe("/auth/login#r=" + encodeURIComponent("/orders"));
  });

  it("an unknown host passes through with the fragment dropped", async () => {
    const out = await makeHandler(open).handler(req("unknown.example.com", "/a#b"));
    expect(out.uri).toBe("/a");
  });

  it("leaves a percent-encoded %23 / %2523 untouched", async () => {
    const { handler } = makeHandler(open);
    for (const uri of ["/auth/login%23r=%252F", "/auth/login%2523r=%25252F", "/x%23y"]) {
      const out = await handler(req(HOST, uri));
      const want = uri.indexOf("/auth/") === 0 ? `/o/${ORG}/shop${uri}` : `/o/${ORG}/shop/site${uri}`;
      expect(out.uri).toBe(want);
      expectValidUri(out.uri);
    }
  });

  it("leaves ordinary paths exactly as before", async () => {
    const { handler } = makeHandler(open);
    expect((await handler(req(HOST, "/"))).uri).toBe(`/o/${ORG}/shop/site/`);
    expect((await handler(req(HOST, "/auth/login"))).uri).toBe(`/o/${ORG}/shop/auth/login`);
    expect((await handler(req(HOST, "/e/foo"))).uri).toBe(`/o/${ORG}/shop/site/e/foo`);
    expect((await handler(req(HOST, "/static/a.css"))).uri).toBe(`/_appstatic/${ORG}/shop/a.css`);
  });
});
