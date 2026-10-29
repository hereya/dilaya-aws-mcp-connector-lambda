import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// Région Canada (t_rca_ca_site_serving). A SECONDARY pod serves its orgs' sites
// through the PRIMARY's app-content edge: it creates no edge resource (the
// distribution, router function, host-map KVS, cert, DNS, DMARC, BYOD grants
// and re-stamp trigger exist once per account), only its own static-assets
// bucket, and its connector writes its hosts into the primary's KVS. Every
// template without `appContentHostKvsArn` is unchanged (scripts/synth-golden.ts).
const KVS = "arn:aws:cloudfront::123456789012:key-value-store/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab";
const SECRET = "0123456789abcdef0123456789abcdef";
const CA = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  originDomain: "app-ca.dilaya.eu",
  skipGlobalResources: "true",
};
const CONSUMER = { appContentDomain: "dilaya-apps.eu", appContentZoneId: "ZAPP", appContentHostKvsArn: KVS };

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-appcontent-consumer-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://dilaya.eu/oauth/connect" };
  process.env.hereyaProjectEnv = "{}";
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "Consumer", {
    env: { account: "123456789012", region: "ca-central-1" },
  });
  return Template.fromStack(stack);
}
const fnEnv = (t: Template, key: string): Record<string, any> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.[key] !== undefined
  )?.Properties.Environment.Variables;
const statements = (t: Template): any[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
const count = (t: Template, type: string) => Object.keys(t.findResources(type)).length;

describe("secondary pod consuming the primary's app-content edge", () => {
  it("creates no edge resource: no distribution, function, KVS, record, OAC or trigger", () => {
    const t = synth({ ...CA, ...CONSUMER, appContentOriginSecret: SECRET });
    for (const type of [
      "AWS::CloudFront::Distribution",
      "AWS::CloudFront::Function",
      "AWS::CloudFront::KeyValueStore",
      "AWS::CloudFront::OriginAccessControl",
      "AWS::CloudFront::CachePolicy",
      "AWS::CloudFront::OriginRequestPolicy",
    ]) {
      expect([type, count(t, type)]).toEqual([type, 0]);
    }
    const records = (Object.values(t.findResources("AWS::Route53::RecordSet")) as any[]).map((r) => r.Properties.Name);
    expect(records.join(",")).not.toContain("dilaya-apps.eu");
    expect(JSON.stringify(t.toJSON())).not.toContain("ByodOriginRestamp");
    expect(JSON.stringify(statements(t))).not.toContain("cloudfront:CreateDistribution");
  });

  it("owns ONE static-assets bucket, readable by this account's distributions only", () => {
    const t = synth({ ...CA, ...CONSUMER });
    expect(count(t, "AWS::S3::Bucket")).toBeGreaterThanOrEqual(1);
    const policies = Object.values(t.findResources("AWS::S3::BucketPolicy")) as any[];
    const cf = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find((s: any) => s.Principal?.Service === "cloudfront.amazonaws.com");
    expect(cf.Action).toBe("s3:GetObject");
    expect(cf.Condition).toEqual({
      StringLike: { "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/*" },
    });
    const out = t.toJSON().Outputs.AppContentRegionOrigin.Value["Fn::Join"][1];
    expect(out[0]).toBe("ca-central-1:app-ca.dilaya.eu:");
    expect(out[1]["Fn::GetAtt"][1]).toBe("RegionalDomainName");
  });

  it("wires the connector to the primary's KVS, its own bucket and the content zone", () => {
    const t = synth({ ...CA, ...CONSUMER });
    const env = fnEnv(t, "POD_ROLE");
    expect(env.APP_CONTENT_DOMAIN).toBe("dilaya-apps.eu");
    expect(env.APP_HOST_KVS_ARN).toBe(KVS);
    expect(env.APP_CONTENT_ZONE_ID).toBe("ZAPP");
    expect(env.APP_STATIC_BUCKET).toEqual({ Ref: expect.stringMatching(/^AppStaticAssetsBucket/) });
    // Nothing that would let it drive the primary's edge or the BYOD control plane.
    for (const k of ["APP_CONTENT_CF_FUNCTION_NAME", "APP_CONTENT_DISTRIBUTION_ID", "APP_CONTENT_ORIGIN_REQUEST_POLICY_ID", "EDGE_LOG_BUCKET"]) {
      expect([k, env[k]]).toEqual([k, undefined]);
    }
    const kvs = statements(t).filter((s) => s.Resource === KVS);
    expect(kvs).toHaveLength(1);
    expect(kvs[0].Action).toEqual(expect.arrayContaining(["cloudfront-keyvaluestore:UpdateKeys", "cloudfront-keyvaluestore:ListKeys"]));
    const zone = statements(t).find((s) => s.Resource === "arn:aws:route53:::hostedzone/ZAPP");
    expect(zone.Action).toContain("route53:ChangeResourceRecordSets");
  });

  it("locks the origin with the shared secret, and keeps its own rotation memory", () => {
    const t = synth({ ...CA, ...CONSUMER, appContentOriginSecret: SECRET });
    const authz = fnEnv(t, "appContentOriginSecret");
    expect(authz.appContentDomain).toBe("dilaya-apps.eu");
    expect(authz.appContentOriginSecret).toBe(SECRET);
    expect(authz.ORIGIN_SECRET_PARAM).toEqual({ Ref: expect.stringMatching(/^AppContentOriginSecretParam/) });
    expect(fnEnv(t, "OTP_SENDER_DOMAIN").OTP_SENDER_DOMAIN).toBe("dilaya-apps.eu");
  });

  it("refuses every other shape at synth, with a reason", () => {
    expect(() => synth({ ...CA, appContentDomain: "dilaya-apps.eu", appContentZoneId: "ZAPP" })).toThrow(
      /appContentDomain is a once-per-account/
    );
    const { skipGlobalResources: _s, originDomain: _o, ...primary } = CA;
    expect(() => synth({ ...primary, ...CONSUMER })).toThrow(/appContentHostKvsArn is for a SECONDARY pod/);
    expect(() => synth({ ...CA, ...CONSUMER, appContentHostKvsArn: "kvs-1" })).toThrow(/must be a CloudFront KeyValueStore ARN/);
    expect(() => synth({ ...CA, ...CONSUMER, appContentZoneId: "" })).toThrow(/requires appContentDomain and appContentZoneId/);
    for (const [k, v] of [
      ["appContentCertArn", "arn:aws:acm:us-east-1:123456789012:certificate/y"],
      ["appContentRegionOrigins", "eu-west-1:app-eu.dilaya.eu:b.s3.eu-west-1.amazonaws.com"],
      ["domainPurchase", "true"],
    ]) {
      expect(() => synth({ ...CA, ...CONSUMER, [k]: v })).toThrow(new RegExp(`${k} belongs to the primary`));
    }
    expect(() => synth({ ...CA, ...CONSUMER, filesDomain: "files.dilaya.eu" })).toThrow(/filesDomain is a once-per-account/);
  });
});
