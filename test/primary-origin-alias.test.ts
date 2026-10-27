import { useStackFixture } from "./core-alarms/helpers";

// t_rca_p1_router step 5 (27/10/2026): the region router's HOME origin is the
// Irish pod's own host (app-eu.dilaya.eu), but the Irish pod owned no such host
// (app-eu answered 404, off the *.dilaya.eu wildcard). `originDomain` cannot
// give it one: it REPLACES the public names, so the pod would drop app.dilaya.eu
// and mcp.dilaya.eu the moment it deployed — a cut before the DNS switch, with
// no way back but a redeploy. `originAlias` ADDS the origin host next to the
// public names: the cutover is then a DNS change, reversible in a minute.
const PUBLIC = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
};
const EU = { ...PUBLIC, originAlias: "app-eu.dilaya.eu" };

function resources(t: any, type: string): any[] {
  return Object.values(t.findResources(type));
}
const domainNames = (t: any) =>
  resources(t, "AWS::ApiGatewayV2::DomainName").map((d) => d.Properties.DomainName).sort();
const recordNames = (t: any) => resources(t, "AWS::Route53::RecordSet").map((r) => r.Properties.Name);

describe("primary pod: originAlias (an origin host NEXT TO the public names)", () => {
  const template = useStackFixture("connector-origin-alias-", "OriginAliasStack");

  it("keeps app.dilaya.eu and mcp.dilaya.eu, and owns app-eu.dilaya.eu as well", () => {
    const t = template(EU);
    expect(domainNames(t)).toEqual(["app-eu.dilaya.eu", "app.dilaya.eu", "mcp.dilaya.eu"]);
    expect(recordNames(t)).toEqual(
      expect.arrayContaining(["app.dilaya.eu.", "mcp.dilaya.eu.", "app-eu.dilaya.eu."])
    );
    expect(resources(t, "AWS::ApiGatewayV2::ApiMapping")).toHaveLength(3);
  });

  it("the public resources keep their logical ids (adding the alias replaces nothing)", () => {
    const before = Object.keys(template(PUBLIC).toJSON().Resources);
    const after = Object.keys(template(EU).toJSON().Resources);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.length - before.length).toBe(3);
  });

  it("refuses the inconsistent shapes at synth, with a reason", () => {
    expect(() => template({ ...EU, originDomain: "ca.app.dilaya.eu" })).toThrow(/originAlias.*originDomain/);
    expect(() => template({ ...PUBLIC, originAlias: "app.dilaya.eu" })).toThrow(/originAlias must differ/);
    expect(() => template({ ...PUBLIC, originAlias: "mcp.dilaya.eu" })).toThrow(/originAlias must differ/);
    expect(() => template({ ...PUBLIC, originAlias: "app-eu.example.com" })).toThrow(
      /originAlias \(app-eu.example.com\) must sit in the customDomain zone dilaya.eu/
    );
    expect(() => template({ originAlias: "app-eu.dilaya.eu" })).toThrow(/originAlias requires customDomain/);
  });
});

// t_rca_p1_router step 6: behind the region router the public name is a CloudFront distribution,
// so the app-content edge (and the connector's BYOD distributions, via POD_ORIGIN_HOST) must
// front the pod's own origin host, never the public name — else every site crosses two edges.
describe("primary pod: the edges front the origin host", () => {
  const template = useStackFixture("connector-origin-alias-edges-", "OriginAliasEdgesStack");
  const APP_CONTENT = {
    appContentDomain: "dilaya-apps.eu",
    appContentZoneId: "ZAPP",
    appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/y",
  };
  const contentOrigin = (t: any) =>
    resources(t, "AWS::CloudFront::Distribution").find((d) =>
      (d.Properties.DistributionConfig.Aliases ?? []).includes("*.dilaya-apps.eu")
    ).Properties.DistributionConfig.Origins[0].DomainName;
  const podOriginEnv = (t: any) =>
    resources(t, "AWS::Lambda::Function")
      .map((f) => f.Properties.Environment?.Variables?.POD_ORIGIN_HOST)
      .filter(Boolean);

  it("with originAlias: the app-content edge fronts app-eu, the connector learns it", () => {
    const t = template({ ...EU, ...APP_CONTENT });
    expect(contentOrigin(t)).toBe("app-eu.dilaya.eu");
    expect(podOriginEnv(t)).toEqual(["app-eu.dilaya.eu"]);
  });

  it("without it: unchanged — the public name, no env", () => {
    const t = template({ ...PUBLIC, ...APP_CONTENT });
    expect(contentOrigin(t)).toBe("app.dilaya.eu");
    expect(podOriginEnv(t)).toEqual([]);
  });
});
