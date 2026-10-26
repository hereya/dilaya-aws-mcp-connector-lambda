import * as cdk from "aws-cdk-lib/core";
import { useStackFixture } from "../core-alarms/helpers";
import { RegionRouterEdgeStack } from "../../lib/stack/region-router/edge-stack";
import { CA, EU, ORIGINS, ROUTER_ENV, SECRET } from "./helpers";

// t_rca_p1_router: what the pod stack synthesizes with the router on — and that it refuses the
// half-configured shapes instead of shipping something else in silence.
const res = (t: any, type: string): any[] => Object.values(t.findResources(type));
const EDGE_ARN = "arn:aws:lambda:us-east-1:123456789012:function:rr-edge:3";

describe("region router: the pod stack", () => {
  const template = useStackFixture("connector-region-stack-", "RegionStack");

  it("absent: no distribution, no KVS, no router function, no secret env anywhere", () => {
    const t = template({ customDomain: "app.dilaya.eu", wildcardCertificateArn: ROUTER_ENV.wildcardCertificateArn });
    expect(res(t, "AWS::CloudFront::Distribution")).toHaveLength(0);
    expect(res(t, "AWS::CloudFront::KeyValueStore")).toHaveLength(0);
    expect(JSON.stringify(t.toJSON())).not.toContain("REGION_ROUTER");
  });

  it("on: one distribution for the public names, home origin with the secret, function + KVS, no DNS for them", () => {
    const t = template(ROUTER_ENV);
    const [d] = res(t, "AWS::CloudFront::Distribution").map((x) => x.Properties.DistributionConfig);
    expect(d.Aliases).toEqual(["app.dilaya.eu", "mcp.dilaya.eu"]);
    expect(d.ViewerCertificate.AcmCertificateArn).toBe(ROUTER_ENV.regionRouterCertArn);
    const [o] = d.Origins;
    expect(o.DomainName).toBe(ORIGINS[EU]);
    expect(o.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    expect(o.OriginCustomHeaders).toEqual([{ HeaderName: "x-dilaya-region-verify", HeaderValue: SECRET }]);
    const b = d.DefaultCacheBehavior;
    expect(b.AllowedMethods).toHaveLength(7);
    expect(b.ViewerProtocolPolicy).toBe("https-only");
    expect(b.FunctionAssociations[0].EventType).toBe("viewer-request");
    expect(b.LambdaFunctionAssociations).toBeUndefined();
    expect(res(t, "AWS::CloudFront::KeyValueStore")).toHaveLength(1);
    const names = res(t, "AWS::Route53::RecordSet").map((r) => r.Properties.Name);
    expect(names).not.toContain("app.dilaya.eu.");
    expect(names).not.toContain("mcp.dilaya.eu.");
  });

  it("with an edge version: the Lambda@Edge rides origin-request WITH the body", () => {
    const t = template({ ...ROUTER_ENV, regionRouterEdgeVersionArn: EDGE_ARN });
    const [d] = res(t, "AWS::CloudFront::Distribution").map((x) => x.Properties.DistributionConfig);
    expect(d.DefaultCacheBehavior.LambdaFunctionAssociations).toEqual([
      { EventType: "origin-request", IncludeBody: true, LambdaFunctionARN: EDGE_ARN },
    ]);
  });

  it("the secret alone (a pod BEHIND the router, e.g. Montréal) creates no edge, only the trust", () => {
    const t = template({
      customDomain: "app.dilaya.eu",
      wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/c",
      originDomain: "app-ca.dilaya.eu",
      skipGlobalResources: "true",
      regionRouterOriginSecret: SECRET,
    });
    expect(res(t, "AWS::CloudFront::Distribution")).toHaveLength(0);
    const fns = res(t, "AWS::Lambda::Function").filter((f) => f.Properties.Environment?.Variables?.REGION_ROUTER_ORIGIN_SECRET);
    // The connector and the PRM.
    expect(fns.map((f) => Object.keys(f.Properties.Environment.Variables).includes("SERVICE_URL")).sort()).toEqual([false, true]);
  });

  it.each([
    [{ regionRouterOriginSecret: "" }, /requires regionRouterOriginSecret/],
    [{ regionRouterOriginSecret: "short" }, /32-256 printable/],
    [{ regionRouterOriginSecret: "a".repeat(40) + "==" }, /without '='/],
    [{ regionRouterOrigins: "" }, /no origin given/],
    [{ regionRouterOrigins: "eu-west-1=app-eu.dilaya.eu" }, /not <region>:<host>/],
    [{ regionRouterOrigins: "eu-west-1:app.dilaya.eu" }, /PUBLIC name/],
    [{ regionRouterOrigins: `${EU}:a.dilaya.eu,${EU}:b.dilaya.eu` }, /listed twice/],
    [{ regionRouterCertArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x" }, /us-east-1 ACM/],
    [{ regionRouterEdgeVersionArn: "arn:aws:lambda:eu-west-1:123456789012:function:x:1" }, /numbered us-east-1/],
    [{ regionRouterEdgeVersionArn: "arn:aws:lambda:us-east-1:123456789012:function:x" }, /numbered us-east-1/],
    [{ skipGlobalResources: "true" }, /not on a secondary pod/],
  ])("refuses %p", (patch, msg) => {
    expect(() => template({ ...ROUTER_ENV, ...patch })).toThrow(msg);
  });

  it("refuses router inputs without regionRouter=true (never a silent no-op)", () => {
    const { regionRouter: _off, ...rest } = ROUTER_ENV;
    expect(() => template(rest)).toThrow(/regionRouter is not "true"/);
  });
});

describe("region router: the us-east-1 edge stack", () => {
  it("refuses any region but us-east-1", () => {
    const app = new cdk.App();
    expect(
      () => new RegionRouterEdgeStack(app, "X", { env: { account: "123456789012", region: EU }, origins: ORIGINS, home: EU })
    ).toThrow(/us-east-1/);
  });

  it("synthesizes one function, a version, an edgelambda-trusted role and the version output", () => {
    const { Template } = require("aws-cdk-lib/assertions");
    const app = new cdk.App();
    const s = new RegionRouterEdgeStack(app, "Y", { env: { account: "123456789012", region: "us-east-1" }, origins: ORIGINS, home: CA });
    const t = Template.fromStack(s);
    t.resourceCountIs("AWS::Lambda::Function", 1);
    t.resourceCountIs("AWS::Lambda::Version", 1);
    expect(JSON.stringify(t.findResources("AWS::IAM::Role"))).toContain("edgelambda.amazonaws.com");
    expect(Object.keys(t.findOutputs("*"))).toContain("EdgeVersionArn");
  });
});
