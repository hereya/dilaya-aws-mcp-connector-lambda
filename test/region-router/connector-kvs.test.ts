import { useStackFixture } from "../core-alarms/helpers";
import { ROUTER_ENV } from "./helpers";

// t_rca_p1_router lot 2: the connector keeps the router's org → region KVS in
// sync (dilaya-connector src/region-router/). It needs the store's ARN and the
// data-plane actions it calls — on THAT store only — and nothing at all when
// the router is off.
const res = (t: any, type: string): any[] => Object.values(t.findResources(type));
const ACTIONS = [
  "cloudfront-keyvaluestore:DescribeKeyValueStore",
  "cloudfront-keyvaluestore:ListKeys",
  "cloudfront-keyvaluestore:UpdateKeys",
];

function handlerVars(t: any): Record<string, any> {
  const fn = res(t, "AWS::Lambda::Function").find((f) => f.Properties?.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS);
  return fn.Properties.Environment.Variables;
}

function routerStatements(t: any): any[] {
  return res(t, "AWS::IAM::Policy")
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s: any) => JSON.stringify(s.Action).includes("cloudfront-keyvaluestore") && JSON.stringify(s.Resource).includes("RegionRouterKvs"));
}

describe("region router: the connector's access to its KVS", () => {
  const template = useStackFixture("connector-region-kvs-", "RegionKvsStack");

  it("on: REGION_ROUTER_KVS_ARN is the router store's ARN", () => {
    const t = template(ROUTER_ENV);
    const [kvsId] = Object.keys(t.findResources("AWS::CloudFront::KeyValueStore"));
    expect(handlerVars(t).REGION_ROUTER_KVS_ARN).toEqual({ "Fn::GetAtt": [kvsId, "Arn"] });
  });

  it("on: exactly the three actions the connector calls, on that store and nothing else", () => {
    const t = template(ROUTER_ENV);
    const [kvsId] = Object.keys(t.findResources("AWS::CloudFront::KeyValueStore"));
    const stmts = routerStatements(t);
    expect(stmts).toHaveLength(1);
    expect([].concat(stmts[0].Action).sort()).toEqual([...ACTIONS].sort());
    expect(stmts[0].Resource).toEqual({ "Fn::GetAtt": [kvsId, "Arn"] });
    expect(stmts[0].Effect).toBe("Allow");
  });

  it("off (today's prod): no variable, no grant", () => {
    const t = template({ customDomain: "app.dilaya.eu", wildcardCertificateArn: ROUTER_ENV.wildcardCertificateArn });
    expect(handlerVars(t).REGION_ROUTER_KVS_ARN).toBeUndefined();
    expect(JSON.stringify(t.toJSON())).not.toContain("REGION_ROUTER_KVS_ARN");
  });

  it("a pod BEHIND the router (secret alone) does not get the store either", () => {
    const t = template({
      customDomain: "app.dilaya.eu",
      wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/c",
      originDomain: "app-ca.dilaya.eu",
      skipGlobalResources: "true",
      regionRouterOriginSecret: ROUTER_ENV.regionRouterOriginSecret,
    });
    expect(handlerVars(t).REGION_ROUTER_KVS_ARN).toBeUndefined();
  });
});
