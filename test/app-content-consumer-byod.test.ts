import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { parseByodEdge } from "../lib/stack/app-content/byod-edge";
import { resolvedEnvBytes } from "./helpers/env-size";

// Région Canada (t_rca_byod_ca). A consumer pod given `appContentByodEdge` runs
// the BYOD control plane for its orgs' custom domains: the primary's edge ids in
// its connector's env (so the distributions it creates are the ones the primary
// would create) and the primary's BYOD grants. Without the parameter the
// consumer template is unchanged (scripts/synth-golden.ts, profile h).
const KVS = "arn:aws:cloudfront::123456789012:key-value-store/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const STATIC = "p-00000000-1111-2222-3333-appstaticassetsbucketd2a-abcdefghijkl.s3.eu-west-1.amazonaws.com";
const LOGS = "p-00000000-1111-2222-3333-edgeaccesslogbucket543d6-abcdefghijkl.s3.eu-west-1.amazonaws.com";
const EDGE = [
  "eu-apphost-router-fn01",
  "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
  "cccccccc-4444-4555-8666-dddddddddddd",
  "E1ABCDEFGHIJKL",
  STATIC,
  LOGS,
  "app-eu.dilaya.eu",
].join(":");
const CA = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  originDomain: "app-ca.dilaya.eu",
  skipGlobalResources: "true",
  appContentDomain: "dilaya-apps.eu",
  appContentZoneId: "ZAPP",
  appContentHostKvsArn: KVS,
  appContentOriginSecret: SECRET,
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-consumer-byod-"));
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
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "ConsumerByod", {
    env: { account: "123456789012", region: "ca-central-1" },
  });
  return Template.fromStack(stack);
}
const handlerEnv = (t: Template): Record<string, any> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.POD_ROLE !== undefined
  )!.Properties.Environment.Variables;
const statements = (t: Template): any[] =>
  (Object.values(t.findResources("AWS::IAM::Policy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
const actions = (s: any): string[] => [s.Action].flat();

describe("consumer pod with the BYOD control plane (appContentByodEdge)", () => {
  it("hands the connector the PRIMARY's edge ids, the bucket domains and origin host as explicit overrides", () => {
    const env = handlerEnv(synth({ ...CA, appContentByodEdge: EDGE }));
    expect(env.APP_CONTENT_CF_FUNCTION_NAME).toBe("eu-apphost-router-fn01");
    expect(env.APP_CONTENT_ORIGIN_REQUEST_POLICY_ID).toBe("aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb");
    expect(env.APP_CONTENT_CACHE_POLICY_ID).toBe("cccccccc-4444-4555-8666-dddddddddddd");
    expect(env.APP_STATIC_OAC_ID).toBe("E1ABCDEFGHIJKL");
    expect(env.APP_STATIC_BUCKET_DOMAIN).toBe(STATIC);
    expect(env.EDGE_LOG_BUCKET_DOMAIN).toBe(LOGS);
    expect(env.POD_ORIGIN_HOST).toBe("app-eu.dilaya.eu");
    expect(env.APP_CONTENT_ORIGIN_SECRET).toBe(SECRET);
    // Its own bucket stays its own (deploy-backend writes there); no edge-log reader, no distribution id.
    expect(env.APP_STATIC_BUCKET).toEqual({ Ref: expect.stringMatching(/^AppStaticAssetsBucket/) });
    for (const k of ["EDGE_LOG_BUCKET", "APP_CONTENT_DISTRIBUTION_ID", "DOMAIN_PURCHASE_ENABLED"]) {
      expect([k, env[k]]).toEqual([k, undefined]);
    }
  });

  it("gets the primary's BYOD grants — tag-gated (dilaya:byod=1) — and the log bucket's ACL read, nothing more", () => {
    const st = statements(synth({ ...CA, appContentByodEdge: EDGE }));
    const create = st.find((s) => actions(s).includes("cloudfront:CreateDistribution"));
    expect(create.Condition.StringEquals).toEqual({ "aws:RequestTag/dilaya:byod": "1" });
    const update = st.find((s) => actions(s).includes("cloudfront:UpdateDistribution"));
    expect(update.Condition.StringEquals).toEqual({ "aws:ResourceTag/dilaya:byod": "1" });
    expect(update.Resource).toBe("arn:aws:cloudfront::123456789012:distribution/*");
    const cert = st.find((s) => actions(s).includes("acm:RequestCertificate"));
    expect(cert.Condition.StringEquals).toEqual({ "aws:RequestTag/dilaya:byod": "1" });
    const acl = st.find((s) => actions(s).includes("s3:GetBucketAcl"));
    expect(acl.Resource).toBe("arn:aws:s3:::p-00000000-1111-2222-3333-edgeaccesslogbucket543d6-abcdefghijkl");
    const all = JSON.stringify(st);
    for (const a of ["route53domains:", "cloudfront:UpdateFunction", "cloudfront:PublishFunction", "route53:CreateHostedZone"]) {
      expect([a, all.includes(a)]).toEqual([a, false]);
    }
  });

  // t_rca_edge_usage_ca: the connector's consumer reader folds this pod's
  // orgs' edge traffic from the shared log. READ only, `cf/` only.
  it("reads the shared edge log — list + get on cf/ only, never write or delete", () => {
    const st = statements(synth({ ...CA, appContentByodEdge: EDGE }));
    const bucket = "arn:aws:s3:::p-00000000-1111-2222-3333-edgeaccesslogbucket543d6-abcdefghijkl";
    const list = st.filter((s) => actions(s).includes("s3:ListBucket"));
    expect(list).toHaveLength(1);
    expect(actions(list[0])).toEqual(["s3:ListBucket"]);
    expect(list[0].Resource).toBe(bucket);
    expect(list[0].Condition).toEqual({ StringLike: { "s3:prefix": ["cf/*"] } });
    const get = st.filter((s) => actions(s).includes("s3:GetObject") && JSON.stringify(s.Resource).includes("edgeaccesslog"));
    expect(get).toHaveLength(1);
    expect(actions(get[0])).toEqual(["s3:GetObject"]);
    expect(get[0].Resource).toBe(`${bucket}/cf/*`);
    const onLogs = JSON.stringify(st.filter((s) => JSON.stringify(s.Resource ?? "").includes("edgeaccesslog")));
    for (const a of ["s3:PutObject", "s3:DeleteObject", "s3:*"]) expect([a, onLogs.includes(a)]).toEqual([a, false]);
    // Without the BYOD edge: no read of the primary's log.
    expect(JSON.stringify(statements(synth(CA)))).not.toContain("edgeaccesslog");
  });

  it("can write records into a Dilaya-held zone — the primary's exact grant — but never buy", () => {
    const st = statements(synth({ ...CA, appContentByodEdge: EDGE }));
    const write = st.filter((s) => s.Resource === "arn:aws:route53:::hostedzone/*");
    expect(write).toHaveLength(1);
    expect(actions(write[0]).sort()).toEqual([
      "route53:ChangeResourceRecordSets",
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets",
    ]);
    expect(write[0].Condition).toBeUndefined();
    // Without the BYOD edge: only the content zone, never the wildcard.
    expect(JSON.stringify(statements(synth(CA)))).not.toContain("hostedzone/*");
  });

  it("holds the same record-write statement as a primary with domainPurchase", () => {
    const { appContentHostKvsArn: _k, skipGlobalResources: _s, originDomain: _o, appContentOriginSecret: _x, ...primary } = CA;
    const eu = statements(
      synth({ ...primary, appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/y", domainPurchase: "true" })
    ).filter((s) => s.Resource === "arn:aws:route53:::hostedzone/*");
    const ca = statements(synth({ ...CA, appContentByodEdge: EDGE })).filter((s) => s.Resource === "arn:aws:route53:::hostedzone/*");
    expect(ca).toEqual(eu);
  });

  it("creates no edge resource either", () => {
    const t = synth({ ...CA, appContentByodEdge: EDGE });
    for (const type of ["AWS::CloudFront::Distribution", "AWS::CloudFront::Function", "AWS::CloudFront::CachePolicy"]) {
      expect([type, Object.keys(t.findResources(type)).length]).toEqual([type, 0]);
    }
    expect(JSON.stringify(t.toJSON())).not.toContain("ByodOriginRestamp");
  });

  // Live CA Handler (29/10): 2 928 bytes of JSON. The connector env test's budget is 3 700.
  it("weighs at most 772 bytes on top of the consumer env", () => {
    const base = synth(CA);
    const byod = synth({ ...CA, appContentByodEdge: EDGE });
    const delta =
      resolvedEnvBytes(handlerEnv(byod), byod.toJSON().Resources) -
      resolvedEnvBytes(handlerEnv(base), base.toJSON().Resources);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(3700 - 2928);
  });

  it("refuses every other shape at synth, with a reason", () => {
    const { appContentHostKvsArn: _k, skipGlobalResources: _s, originDomain: _o, ...primary } = CA;
    expect(() => synth({ ...primary, appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/y", appContentByodEdge: EDGE })).toThrow(
      /appContentByodEdge is for a consumer pod/
    );
    const { appContentOriginSecret: _x, ...noSecret } = CA;
    expect(() => synth({ ...noSecret, appContentByodEdge: EDGE })).toThrow(/requires appContentOriginSecret/);
    expect(() => synth({ ...CA, appContentByodEdge: EDGE.split(":").slice(0, 6).join(":") })).toThrow(/6 fields/);
  });
});

describe("parseByodEdge", () => {
  it("is undefined when absent and parses the seven fields in order", () => {
    expect(parseByodEdge(undefined)).toBeUndefined();
    expect(parseByodEdge("")).toBeUndefined();
    expect(parseByodEdge(EDGE)).toEqual({
      functionName: "eu-apphost-router-fn01",
      originRequestPolicyId: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
      cachePolicyId: "cccccccc-4444-4555-8666-dddddddddddd",
      staticOacId: "E1ABCDEFGHIJKL",
      staticBucketDomain: STATIC,
      edgeLogBucketDomain: LOGS,
      originHost: "app-eu.dilaya.eu",
    });
  });

  it("names the field that is wrong — a swapped pair never synthesizes", () => {
    const f = EDGE.split(":");
    const swap = (i: number, j: number) => {
      const g = [...f];
      [g[i], g[j]] = [g[j]!, g[i]!];
      return g.join(":");
    };
    expect(() => parseByodEdge(swap(3, 4))).toThrow(/static OAC id/);
    expect(() => parseByodEdge(swap(0, 6))).toThrow(/router function name/);
    expect(() => parseByodEdge(swap(1, 6))).toThrow(/origin-request policy id/);
    expect(() => parseByodEdge(f.map((x, i) => (i === 5 ? "logs.example.com" : x)).join(":"))).toThrow(/edge-log bucket/);
    expect(() => parseByodEdge(f.map((x, i) => (i === 6 ? "https://app-eu.dilaya.eu" : x)).join(":"))).toThrow(/fields|origin host/);
  });
});
