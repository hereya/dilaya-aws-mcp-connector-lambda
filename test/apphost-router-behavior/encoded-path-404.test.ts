import { makeHandler, req, HOST, ORG } from "./helpers";

// t_edge_404_percent_bypass (2026-10-13): the two 404 rules of the login gate
// (dot-path, server-script path) tested `request.uri` AS SENT — percent-encoded.
// A scanner that writes /%2Eenv instead of /.env slipped past both: the edge
// saw no "." and answered a login redirect (each probe a distinct return path,
// each one a render), while the origin decodes and serves the very same path.
// Proven in prod the same morning: 178.16.54.197 sent /%252egit-credentials to
// juliefaitout.fr and got 302 where its 216 plain dot-paths got the edge 404;
// a live probe at 06:15Z: /.env 404, /%2Eenv 302, /%2e%65nv 302, /%2Egit/config 302.
//
// The rules now run on a DECODED copy of the path (two passes — the origin chain
// decodes up to twice: API Gateway, then the app), pair by pair so a malformed
// escape cannot switch the decoding off. Routing keeps request.uri untouched.

const closed = { [HOST]: JSON.stringify({ o: ORG, a: "shop", auth: 1, pub: ["/"] }) };
const open = { [HOST]: JSON.stringify({ o: ORG, a: "shop" }) };
const withCookie = (uri: string) => {
  const r = req(HOST, uri) as any;
  r.request.cookies = { dilaya_id_token: { value: "x" } };
  return r;
};

describe("apphost router — percent-encoded paths meet the same 404 rules", () => {
  it("answers an encoded dot-path or script path with the bare 404, on every site", async () => {
    const probes = [
      "/%2Eenv", "/%2e%65nv", "/%252Eenv", "/%252egit-credentials", "/%2Egit/config",
      "/app/%2Eaws/credentials", "/x%2Ephp", "/wp-login%2Ephp", "/admin%2EPHP", "/%2Eenv%ZZ",
    ];
    for (const site of [closed, open]) {
      const { handler, cf } = makeHandler(site);
      for (const uri of probes) {
        const out = await handler(req(HOST, uri));
        expect([uri, out.statusCode]).toEqual([uri, 404]);
        expect(out.headers.location).toBeUndefined();
        expect(out.headers["cache-control"].value).toBe("no-store");
      }
      expect(cf.lastOrigin).toBeUndefined();
    }
  });

  it("decodes BEFORE the /.well-known exemption, and routes the raw URI untouched", async () => {
    const { handler } = makeHandler(open);
    const ok = await handler(req(HOST, "/%2Ewell-known/security.txt"));
    expect(ok.statusCode).toBeUndefined();
    expect(ok.uri).toBe(`/o/${ORG}/shop/site/%2Ewell-known/security.txt`);
    // a dot-file INSIDE .well-known is a dot-path today in its plain spelling — same when encoded
    expect((await handler(req(HOST, "/.well-known/%2Efoo"))).statusCode).toBe(404);
    expect((await handler(req(HOST, "/.well-known/.foo"))).statusCode).toBe(404);
  });

  it("a malformed escape never throws — an ordinary path keeps its usual answer", async () => {
    const gated = makeHandler(closed).handler;
    expect((await gated(req(HOST, "/orders/%E0%A4%A"))).statusCode).toBe(302);
    expect((await gated(req(HOST, "/orders/42%"))).statusCode).toBe(302);
    const { handler } = makeHandler(open);
    const out = await handler(req(HOST, "/orders/%E0%A4%A"));
    expect(out.statusCode).toBeUndefined();
    expect(out.uri).toBe(`/o/${ORG}/shop/site/orders/%E0%A4%A`);
  });

  it("a signed-in visitor still reaches the app on an encoded dot-path", async () => {
    const { handler } = makeHandler(closed);
    expect((await handler(withCookie("/%2Eenv"))).uri).toBe(`/o/${ORG}/shop/site/%2Eenv`);
  });
});
