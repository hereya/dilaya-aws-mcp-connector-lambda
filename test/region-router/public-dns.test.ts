import { useStackFixture } from "../core-alarms/helpers";
import { ROUTER_ENV } from "./helpers";

// t_rca_p1_router step 6: the cutover is `regionRouterPublicDns=true`. The public records stay the
// pod's (same logical ids) and only their alias target moves from API Gateway to the router's
// distribution — an in-place UPSERT both ways, never a delete + create with a gap. The API Gateway
// domains stay, so a resolver holding the old answer still reaches the same pod.
const { originDomain: _origin, ...rest } = ROUTER_ENV;
const EU_ROUTER = { ...rest, originAlias: "app-eu.dilaya.eu" };
const CF_ZONE = "Z2FDTNDATAQYW2";

const res = (t: any, type: string): [string, any][] => Object.entries(t.findResources(type));
const record = (t: any, name: string) => res(t, "AWS::Route53::RecordSet").find(([, r]) => r.Properties.Name === name)!;

describe("region router: the public DNS cutover", () => {
  const template = useStackFixture("connector-region-public-dns-", "RegionPublicDnsStack");

  it("router on, flag off: app/mcp still point at API Gateway (the router answers only on cloudfront.net)", () => {
    const t = template(EU_ROUTER);
    for (const name of ["app.dilaya.eu.", "mcp.dilaya.eu."]) {
      expect(record(t, name)[1].Properties.AliasTarget.HostedZoneId).not.toBe(CF_ZONE);
    }
  });

  it("flag on: app/mcp alias the router distribution, same logical ids, API Gateway domains kept", () => {
    const before = template(EU_ROUTER);
    const t = template({ ...EU_ROUTER, regionRouterPublicDns: "true" });
    const [distId] = res(t, "AWS::CloudFront::Distribution").find(([, d]) =>
      (d.Properties.DistributionConfig.Aliases ?? []).includes("app.dilaya.eu")
    )!;
    for (const name of ["app.dilaya.eu.", "mcp.dilaya.eu."]) {
      const [id, r] = record(t, name);
      expect(r.Properties.AliasTarget.HostedZoneId).toBe(CF_ZONE);
      expect(r.Properties.AliasTarget.DNSName).toEqual({ "Fn::GetAtt": [distId, "DomainName"] });
      expect(record(before, name)[0]).toBe(id);
    }
    const domains = res(t, "AWS::ApiGatewayV2::DomainName").map(([, d]) => d.Properties.DomainName).sort();
    expect(domains).toEqual(["app-eu.dilaya.eu", "app.dilaya.eu", "mcp.dilaya.eu"]);
    // The pod's origin host keeps pointing at API Gateway — it IS the router's home origin.
    expect(record(t, "app-eu.dilaya.eu.")[1].Properties.AliasTarget.HostedZoneId).not.toBe(CF_ZONE);
  });

  it("refuses the flag without the router, and on a pod that does not own the public names", () => {
    const { regionRouter: _r, regionRouterOrigins: _o, regionRouterCertArn: _c, ...noRouter } = EU_ROUTER;
    expect(() => template({ ...noRouter, regionRouterPublicDns: "true" })).toThrow(/regionRouterPublicDns is set but regionRouter is not "true"/);
    expect(() => template({ ...ROUTER_ENV, regionRouterPublicDns: "true" })).toThrow(/use originAlias, not originDomain/);
  });
});
