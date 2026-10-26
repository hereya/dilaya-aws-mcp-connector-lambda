import { useStackFixture } from "../core-alarms/helpers";
import { PRM_SOURCE, prmCode } from "../../lib/stack/prm";
import { trustViewerHostInPrm } from "../../lib/stack/region-router/pod-trust";
import { SECRET } from "./helpers";

// t_rca_p1_router, pod side: behind the router API Gateway sees the pod's ORIGIN host, so the PRM
// must read the forwarded viewer host — but only when the request proves the shared secret.
// The synthesized PRM handler is RUN on API Gateway events.
const ENV = { MCP_DOMAIN: "mcp.dilaya.eu", SERVICE_URL: "https://app.dilaya.eu", OAUTH_SERVER_URL: "https://dilaya.eu/oauth/connect" };

function prmFrom(t: any) {
  const fn = Object.values(t.findResources("AWS::Lambda::Function")).find(
    (f: any) => f.Properties.Environment?.Variables?.SERVICE_URL
  ) as any;
  return { code: fn.Properties.Code.ZipFile as string, env: fn.Properties.Environment.Variables as Record<string, string> };
}

async function resource(code: string, env: Record<string, string>, ev: any): Promise<string> {
  const saved = { ...process.env };
  Object.assign(process.env, ENV, env);
  try {
    const mod = { exports: {} as any };
    new Function("module", "exports", "require", "Buffer", code)(mod, mod.exports, require, Buffer);
    return JSON.parse((await mod.exports.handler(ev)).body).resource;
  } finally {
    process.env = saved;
  }
}

const ev = (domainName: string, headers: Record<string, string> = {}) => ({
  rawPath: "/.well-known/oauth-protected-resource",
  headers,
  requestContext: { domainName },
});
const viaRouter = (host: string, proof = SECRET) =>
  ev("app-eu.dilaya.eu", { "x-dilaya-viewer-host": host, "x-dilaya-region-verify": proof });

describe("region router: the pod honours the viewer host only behind the secret", () => {
  const template = useStackFixture("connector-region-trust-", "RegionTrustStack");
  const BEHIND = {
    customDomain: "app.dilaya.eu",
    wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
    originDomain: "app-eu.dilaya.eu",
  };

  it("absent the secret, the PRM source is exactly today's", () => {
    expect(prmCode(undefined)).toBe(PRM_SOURCE);
    const { code, env } = prmFrom(template(BEHIND));
    expect(code).toBe(PRM_SOURCE);
    expect(env.REGION_ROUTER_ORIGIN_SECRET).toBeUndefined();
  });

  it("without the secret configured, a forwarded mcp host is IGNORED (anyone can send the header)", async () => {
    const { code, env } = prmFrom(template(BEHIND));
    expect(await resource(code, env, viaRouter("mcp.dilaya.eu"))).toBe("https://app.dilaya.eu/mcp");
  });

  describe("with regionRouterOriginSecret", () => {
    let code: string;
    let env: Record<string, string>;
    beforeAll(() => {
      ({ code, env } = prmFrom(template({ ...BEHIND, regionRouterOriginSecret: SECRET })));
    });

    it("the router's request for the plugin host gets the plugin resource", async () => {
      expect(env.REGION_ROUTER_ORIGIN_SECRET).toBe(SECRET);
      expect(await resource(code, env, viaRouter("mcp.dilaya.eu"))).toBe("https://mcp.dilaya.eu");
      expect(await resource(code, env, viaRouter("MCP.DILAYA.EU"))).toBe("https://mcp.dilaya.eu");
      expect(await resource(code, env, viaRouter("app.dilaya.eu"))).toBe("https://app.dilaya.eu/mcp");
    });

    it.each([
      ["a wrong secret", viaRouter("mcp.dilaya.eu", "x".repeat(SECRET.length))],
      ["a secret of another length", viaRouter("mcp.dilaya.eu", "short")],
      ["no proof header", ev("app-eu.dilaya.eu", { "x-dilaya-viewer-host": "mcp.dilaya.eu" })],
      ["an empty viewer host", viaRouter("")],
    ])("%s → the viewer host is ignored", async (_l, e) => {
      expect(await resource(code, env, e)).toBe("https://app.dilaya.eu/mcp");
    });

    it("a direct hit on the public plugin host (no router) still works as today", async () => {
      expect(await resource(code, env, ev("mcp.dilaya.eu"))).toBe("https://mcp.dilaya.eu");
    });

    it("the connector Lambda carries the secret as well", () => {
      const t = template({ ...BEHIND, regionRouterOriginSecret: SECRET });
      const handler = Object.values(t.findResources("AWS::Lambda::Function")).find(
        (f: any) => f.Properties.Environment?.Variables?.customDomain
      ) as any;
      expect(handler.Properties.Environment.Variables.REGION_ROUTER_ORIGIN_SECRET).toBe(SECRET);
    });
  });

  it("refuses to patch a PRM source whose host test moved (never a silent no-trust)", () => {
    expect(() => trustViewerHostInPrm("exports.handler = async () => ({})")).toThrow(/not found exactly once/);
  });

  it("the patched PRM still fits CloudFormation's inline-code limit", () => {
    expect(prmCode(SECRET).length).toBeLessThanOrEqual(4096);
  });
});
