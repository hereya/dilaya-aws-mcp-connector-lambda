import { MAX_BODY_BYTES } from "../../lib/stack/region-router/edge-handler";
import { CA, EU, ORG_CA, ORG_CA2, ORG_EU, ORIGINS, SECRET, edgeCode, edgeEvent, makeEdge, toolCall } from "./helpers";

// t_rca_p1_router: the origin-request Lambda@Edge, lifted from the synthesized us-east-1 stack
// and executed on origin-request events shaped like CloudFront's.
describe("region router: the Lambda@Edge (multi-org token → body org → region)", () => {
  let handler: (e: any) => Promise<any>;
  let code: string;
  beforeAll(() => {
    code = edgeCode();
    handler = makeEdge(code);
  });

  const MIXED = `${ORG_CA}:${CA},${ORG_CA2}:${CA}`;
  const out = async (ev: ReturnType<typeof edgeEvent>) => {
    const req = await handler(ev);
    return {
      domain: req.origin.custom.domainName,
      host: req.headers.host[0].value,
      route: req.headers["x-dilaya-route"][0].value,
      req,
    };
  };

  it("multi-org token, body names a Montréal org → Montréal origin, Host follows, secret header kept", async () => {
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body: JSON.stringify(toolCall(ORG_CA)) }));
    expect(r.domain).toBe(ORIGINS[CA]);
    expect(r.host).toBe(ORIGINS[CA]);
    expect(r.route).toBe(`body-${CA}`);
    expect(r.req.origin.custom.customHeaders["x-dilaya-region-verify"][0].value).toBe(SECRET);
    // The body is never rewritten: the origin receives it whole.
    expect(r.req.body.action).toBe("read-only");
  });

  it("multi-org token, body names a home-region org → home", async () => {
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body: JSON.stringify(toolCall(ORG_EU)) }));
    expect(r.domain).toBe(ORIGINS[EU]);
    expect(r.route).toBe(`body-${EU}`);
  });

  it.each([
    ["no org (tools/list)", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })],
    ["no org in the arguments", JSON.stringify(toolCall())],
    ["an org the bearer does not hold", JSON.stringify(toolCall("ffffffff-0000-0000-0000-000000000000"))],
    ["unparseable JSON", "{not json"],
    ["an empty body", null],
    ["a batch that disagrees on the org", JSON.stringify([toolCall(ORG_CA, 1), toolCall(ORG_EU, 2)])],
    ["org not a string", JSON.stringify({ params: { arguments: { org: 7 } } })],
  ])("multi-org token, %s → home", async (_l, body) => {
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body }));
    expect(r.domain).toBe(ORIGINS[EU]);
    expect(r.host).toBe(ORIGINS[EU]);
  });

  it("a batch that agrees on one Montréal org routes there", async () => {
    const body = JSON.stringify([toolCall(ORG_CA, 1), { jsonrpc: "2.0", method: "notifications/x" }, toolCall(ORG_CA, 2)]);
    expect((await out(edgeEvent({ route: "body", regions: MIXED, body }))).domain).toBe(ORIGINS[CA]);
  });

  it("a text-encoded body is read as well", async () => {
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body: JSON.stringify(toolCall(ORG_CA)), encoding: "text" }));
    expect(r.domain).toBe(ORIGINS[CA]);
  });

  it("an oversized body is not parsed → home", async () => {
    const big = JSON.stringify({ ...toolCall(ORG_CA), pad: "x".repeat(MAX_BODY_BYTES) });
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body: big }));
    expect(r.domain).toBe(ORIGINS[EU]);
  });

  it("a body CloudFront truncated is not parsed → home", async () => {
    const r = await out(edgeEvent({ route: "body", regions: MIXED, body: JSON.stringify(toolCall(ORG_CA)), truncated: true }));
    expect(r.domain).toBe(ORIGINS[EU]);
  });

  it("a forged org-regions header cannot name a region without an origin", async () => {
    const r = await out(edgeEvent({ route: "body", regions: `${ORG_CA}:ap-south-1`, body: JSON.stringify(toolCall(ORG_CA)) }));
    expect(r.domain).toBe(ORIGINS[EU]);
  });

  it.each(["token", "path", "home", ""])("route=%s (already decided by the viewer function) → untouched", async (route) => {
    const ev = edgeEvent({ route, regions: MIXED, body: JSON.stringify(toolCall(ORG_CA)) });
    const before = JSON.stringify(ev.Records[0].cf.request);
    const req = await handler(ev);
    expect(JSON.stringify(req)).toBe(before);
  });

  it("missing header map entries or a missing body never throw", async () => {
    const ev = edgeEvent({ route: "body" });
    delete (ev.Records[0].cf.request as any).body;
    expect((await out(ev)).domain).toBe(ORIGINS[EU]);
  });

  it("fits CloudFormation's inline-code limit and ships without comment lines", () => {
    expect(code.length).toBeLessThanOrEqual(4096);
    expect(code).not.toMatch(/^\s*\/\//m);
  });
});
