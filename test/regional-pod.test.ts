import { useStackFixture } from "./core-alarms/helpers";

// t_rca_p0_infra (26/10/2026): Région Canada. A second full pod (ca-central-1)
// next to Ireland, both behind the SAME public URL app.dilaya.eu/mcp. The pod
// must be able to OWN an origin host of its own while still accepting and
// advertising the public name — and a secondary pod must not recreate any
// once-per-account resource. Absent both inputs, nothing changes (the golden
// harness proves it byte for byte; the first test pins the visible shape).
const PUBLIC = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
};
const CA = { ...PUBLIC, originDomain: "ca.app.dilaya.eu" };
const APP_CONTENT = {
  appContentDomain: "dilaya-apps.eu",
  appContentZoneId: "ZAPP",
  appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/y",
};

function resources(t: any, type: string): any[] {
  return Object.values(t.findResources(type));
}
const domainNames = (t: any) =>
  resources(t, "AWS::ApiGatewayV2::DomainName").map((d) => d.Properties.DomainName).sort();
const recordNames = (t: any) => resources(t, "AWS::Route53::RecordSet").map((r) => r.Properties.Name);
const fnWith = (t: any, key: string) =>
  resources(t, "AWS::Lambda::Function").find((f) => f.Properties.Environment?.Variables?.[key] !== undefined);

describe("regional pods: originDomain + skipGlobalResources", () => {
  const template = useStackFixture("connector-regional-pod-", "RegionalPodStack");

  it("without originDomain the pod owns the public names, as before", () => {
    const t = template(PUBLIC);
    expect(domainNames(t)).toEqual(["app.dilaya.eu", "mcp.dilaya.eu"]);
    expect(recordNames(t)).toEqual(expect.arrayContaining(["app.dilaya.eu.", "mcp.dilaya.eu."]));
  });

  it("with originDomain the pod owns ONLY its origin host — no public domain, no public record", () => {
    const t = template(CA);
    expect(domainNames(t)).toEqual(["ca.app.dilaya.eu"]);
    const records = recordNames(t);
    expect(records).toContain("ca.app.dilaya.eu.");
    expect(records).not.toContain("app.dilaya.eu.");
    expect(records).not.toContain("mcp.dilaya.eu.");
  });

  it("still accepts and advertises the PUBLIC name (audience, PRM, connector env, Lambda prefix)", () => {
    const t = template(CA);
    const aud = fnWith(t, "EXPECTED_AUDIENCE").Properties.Environment.Variables.EXPECTED_AUDIENCE;
    expect(aud.split(",")).toEqual(["https://app.dilaya.eu/mcp", "https://mcp.dilaya.eu", "https://mcp.dilaya.eu/"]);
    expect(fnWith(t, "SERVICE_URL").Properties.Environment.Variables.SERVICE_URL).toBe("https://app.dilaya.eu");
    const handler = fnWith(t, "customDomain").Properties.Environment.Variables;
    expect(handler.customDomain).toBe("app.dilaya.eu");
    expect(handler.MCP_DOMAIN).toBe("mcp.dilaya.eu");
    expect(resources(t, "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey)).toContain("POST /");
    expect(JSON.stringify(t.toJSON())).toContain("app-app-*");
  });

  it("the app-content edge fronts the pod's origin host, since API Gateway no longer answers the public one", () => {
    const t = template({ ...CA, ...APP_CONTENT });
    const dist = resources(t, "AWS::CloudFront::Distribution").find((d) =>
      (d.Properties.DistributionConfig.Aliases ?? []).includes("*.dilaya-apps.eu")
    );
    expect(dist.Properties.DistributionConfig.Origins[0].DomainName).toBe("ca.app.dilaya.eu");
    // ...and without originDomain it still fronts the public name.
    const before = resources(template({ ...PUBLIC, ...APP_CONTENT }), "AWS::CloudFront::Distribution").find((d) =>
      (d.Properties.DistributionConfig.Aliases ?? []).includes("*.dilaya-apps.eu")
    );
    expect(before.Properties.DistributionConfig.Origins[0].DomainName).toBe("app.dilaya.eu");
  });

  it("publishes the origin URL as an output, only when originDomain is set", () => {
    expect(template(CA).toJSON().Outputs.OriginUrl.Value).toBe("https://ca.app.dilaya.eu");
    expect(template(PUBLIC).toJSON().Outputs.OriginUrl).toBeUndefined();
  });

  it("a secondary pod creates no CloudFront, no us-east-1 certificate, no CloudFront function", () => {
    const cognito = JSON.stringify({ userPoolId: "eu-west-1_X", userPoolClientId: "c" });
    const t = template({ ...CA, skipGlobalResources: "true", hereyaProjectEnv: cognito });
    expect(resources(t, "AWS::CloudFront::Distribution")).toHaveLength(0);
    expect(resources(t, "AWS::CloudFront::Function")).toHaveLength(0);
    expect(resources(t, "AWS::CloudFront::KeyValueStore")).toHaveLength(0);
    expect(resources(t, "AWS::CertificateManager::Certificate")).toHaveLength(0);
    expect(JSON.stringify(t.toJSON())).not.toContain("DnsValidatedCertificate");
    // ...whereas the same Cognito env WITHOUT the flag still builds the legacy frontend distribution.
    const legacy = template({ ...CA, hereyaProjectEnv: cognito });
    expect(resources(legacy, "AWS::CloudFront::Distribution")).toHaveLength(1);
  });

  it("refuses the inconsistent shapes at synth, with a reason", () => {
    expect(() => template({ ...PUBLIC, skipGlobalResources: "true" })).toThrow(/requires originDomain/);
    expect(() => template({ ...CA, ...APP_CONTENT, skipGlobalResources: "true" })).toThrow(/appContentDomain is a once-per-account/);
    expect(() =>
      template({ ...CA, skipGlobalResources: "true", filesDomain: "files.dilaya.eu", filesZoneId: "Z", filesCertArn: "arn:c" })
    ).toThrow(/filesDomain is a once-per-account/);
    expect(() => template({ ...PUBLIC, originDomain: "ca.app.example.com" })).toThrow(/must sit in the customDomain zone dilaya.eu/);
    expect(() => template({ ...PUBLIC, originDomain: "app.dilaya.eu" })).toThrow(/must differ/);
    expect(() => template({ originDomain: "ca.app.dilaya.eu" })).toThrow(/requires customDomain/);
  });
});
