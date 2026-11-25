import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The internal app interface's sandbox origin (lib/stack/app-ui-frame.ts):
// fully inert by default; when on, a distribution that can only read `_appui/*`.
const PROJECT_ENV = { registryTableName: "registry", dataApiUrl: "https://data.example" };
const APP_CONTENT = {
  customDomain: "app.example.eu",
  customDomainZone: "example.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/1111-2222",
  appContentDomain: "example-apps.eu",
  appContentZoneId: "ZAPPCONTENT123",
  appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/3333-4444",
};
const KEYS = ["appUiFrame", "appUiDomain", "appUiZoneId", "appUiCertArn", "appUiConsoleOrigin", "filesDomain", "filesZoneId", "filesCertArn"];
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://files.example.eu; " +
  "font-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors https://example.eu; sandbox allow-scripts allow-forms";

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-appui-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>): Template {
  process.env = {
    ...saved,
    hereyaProjectRootDir: root,
    oauthServerUrl: "https://example.eu/oauth/connect",
    hereyaProjectEnv: JSON.stringify({ ...PROJECT_ENV, bucketName: "files-bucket" }),
  };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "AppUiStack", { env: { account: "123456789012", region: "eu-west-1" } });
  return Template.fromStack(stack);
}

const handlerEnv = (t: Template): Record<string, unknown> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS !== undefined
  ).Properties.Environment.Variables;
const distributions = (t: Template) => t.findResources("AWS::CloudFront::Distribution");
const uiDistribution = (t: Template): [string, any] =>
  Object.entries(distributions(t)).find(([id]) => id.startsWith("AppUiDistribution"))!;

describe("app UI frame, off (default)", () => {
  it.each([
    ["absent", {}],
    ["empty", { appUiFrame: "" }],
    ["false", { appUiFrame: "false" }],
  ])("%s → template byte-identical to a synth without the parameter", (_l, env) => {
    expect(synth({ ...APP_CONTENT, ...(env as Record<string, string>) }).toJSON()).toEqual(synth(APP_CONTENT).toJSON());
  });

  it("creates nothing: no distribution, no headers policy, no env var, no output", () => {
    const t = synth({ ...APP_CONTENT, appUiFrame: "false" });
    expect(Object.keys(distributions(t)).filter((id) => id.startsWith("AppUi"))).toEqual([]);
    t.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 0);
    expect(handlerEnv(t).APP_UI_ORIGIN).toBeUndefined();
    expect(Object.keys(t.findOutputs("*")).filter((k) => k.startsWith("AppUi"))).toEqual([]);
  });

  it("refuses any other value, and a sub-parameter without the switch", () => {
    expect(() => synth({ ...APP_CONTENT, appUiFrame: "yes" })).toThrow(/appUiFrame: "yes"/);
    expect(() => synth({ ...APP_CONTENT, appUiConsoleOrigin: "https://example.eu" })).toThrow(/requires appUiFrame=true/);
  });

  it("refuses to turn on without this pod's own app-content edge", () => {
    expect(() => synth({ appUiFrame: "true" })).toThrow(/needs this pod's own app-content edge/);
  });
});

describe("app UI frame, on (ui.<appContentDomain>)", () => {
  let t: Template;
  beforeAll(() => {
    t = synth({
      ...APP_CONTENT,
      appUiFrame: "true",
      filesDomain: "files.example.eu",
      filesZoneId: "ZFILES123",
      filesCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/5555-6666",
    });
  });

  it("serves ui.<appContentDomain> on the app-content wildcard certificate, GET/HEAD only", () => {
    const [, d] = uiDistribution(t);
    const cfg = d.Properties.DistributionConfig;
    expect(cfg.Aliases).toEqual(["ui.example-apps.eu"]);
    expect(cfg.ViewerCertificate.AcmCertificateArn).toBe(APP_CONTENT.appContentCertArn);
    expect(cfg.DefaultCacheBehavior.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(cfg.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(cfg.DefaultCacheBehavior.OriginRequestPolicyId).toBeUndefined();
    expect(cfg.CacheBehaviors).toBeUndefined();
  });

  it("reaches the static bucket through the pod's OAC, under the _appui origin path only", () => {
    const [, d] = uiDistribution(t);
    const origins = d.Properties.DistributionConfig.Origins;
    expect(origins).toHaveLength(1);
    expect(origins[0].OriginPath).toBe("/_appui");
    expect(JSON.stringify(origins[0].DomainName)).toContain("AppStaticAssetsBucket");
    expect(JSON.stringify(origins[0].OriginAccessControlId)).toContain("AppStaticAssetsOac");
    expect(origins[0].S3OriginConfig.OriginAccessIdentity).toBe("");
  });

  it("adds ONE bucket statement, GetObject on _appui/* for this distribution only", () => {
    const [uiId] = uiDistribution(t);
    const stmts = (Object.values(t.findResources("AWS::S3::BucketPolicy")) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const mine = stmts.filter((s) => JSON.stringify(s).includes(uiId));
    expect(mine).toHaveLength(1);
    expect(mine[0].Sid).toBe("AppUiFrameRead");
    expect(mine[0].Action).toBe("s3:GetObject");
    expect(JSON.stringify(mine[0].Resource)).toContain("/_appui/*");
  });

  it("sends the exact CSP and the other headers", () => {
    const policies = Object.values(t.findResources("AWS::CloudFront::ResponseHeadersPolicy")) as any[];
    expect(policies).toHaveLength(1);
    const cfg = policies[0].Properties.ResponseHeadersPolicyConfig;
    expect(cfg.SecurityHeadersConfig.ContentSecurityPolicy).toEqual({ ContentSecurityPolicy: EXPECTED_CSP, Override: true });
    expect(cfg.SecurityHeadersConfig.ReferrerPolicy).toEqual({ ReferrerPolicy: "no-referrer", Override: true });
    expect(cfg.SecurityHeadersConfig.ContentTypeOptions).toEqual({ Override: true });
    expect(cfg.CorsConfig.AccessControlAllowOrigins.Items).toEqual(["*"]);
    expect(cfg.CorsConfig.AccessControlAllowCredentials).toBe(false);
    const pp = cfg.CustomHeadersConfig.Items.find((h: any) => h.Header === "Permissions-Policy");
    expect(pp.Value).toMatch(/^accelerometer=\(\), /);
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb"]) expect(pp.Value).toContain(`${f}=()`);
    const [, d] = uiDistribution(t);
    expect(JSON.stringify(d.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId)).toContain("AppUiHeadersPolicy");
  });

  it("caches a year with nothing from the viewer in the key", () => {
    const cps = Object.entries(t.findResources("AWS::CloudFront::CachePolicy")).filter(([id]) => id.startsWith("AppUi"));
    expect(cps).toHaveLength(1);
    const c = (cps[0]![1] as any).Properties.CachePolicyConfig;
    expect(c.DefaultTTL).toBe(31536000);
    const k = c.ParametersInCacheKeyAndForwardedToOrigin;
    expect([k.CookiesConfig.CookieBehavior, k.QueryStringsConfig.QueryStringBehavior, k.HeadersConfig.HeaderBehavior]).toEqual(["none", "none", "none"]);
  });

  it("guards the path before the cache: dot segments and encoded separators are refused", () => {
    const fn = Object.entries(t.findResources("AWS::CloudFront::Function")).find(([id]) => id.startsWith("AppUiPathGuard"))!;
    const code: string = (fn[1] as any).Properties.FunctionCode;
    // eslint-disable-next-line no-new-func
    const handler = new Function(`${code}; return handler;`)();
    const run = (uri: string) => handler({ request: { uri } });
    expect(run("/org/app/abc123/index.html")).toEqual({ uri: "/org/app/abc123/index.html" });
    for (const bad of ["/../_appstatic/x", "/a/..%2f/b", "/a//b", "/a/%2E%2E/b", "/a\\b", "a"]) expect(run(bad).statusCode).toBe(400);
  });

  it("puts a TXT name guard at ui.<appContentDomain> BEFORE the distribution, then A + AAAA aliases", () => {
    const [, d] = uiDistribution(t);
    const recs = t.findResources("AWS::Route53::RecordSet");
    const at = (type: string) => Object.entries(recs).filter(([, r]: [string, any]) => r.Properties.Type === type && r.Properties.Name === "ui.example-apps.eu.");
    expect(at("TXT")).toHaveLength(1);
    expect(d.DependsOn).toContain(at("TXT")[0]![0]);
    expect(at("A")).toHaveLength(1);
    expect(at("AAAA")).toHaveLength(1);
  });

  it("gives the connector APP_UI_ORIGIN and outputs AppUiOrigin", () => {
    expect(handlerEnv(t).APP_UI_ORIGIN).toBe("https://ui.example-apps.eu");
    expect(t.findOutputs("AppUiOrigin").AppUiOrigin.Value).toBe("https://ui.example-apps.eu");
  });
});

describe("app UI frame, on a dedicated domain (appUiDomain)", () => {
  const DEDICATED = { appUiDomain: "example-ui.eu", appUiZoneId: "ZUI123", appUiCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/9999-0000" };

  it("uses its own certificate and zone, no name guard, and the console origin it is given", () => {
    const t = synth({ ...APP_CONTENT, appUiFrame: "true", ...DEDICATED, appUiConsoleOrigin: "https://console.example.eu" });
    const cfg = uiDistribution(t)[1].Properties.DistributionConfig;
    expect(cfg.Aliases).toEqual(["example-ui.eu"]);
    expect(cfg.ViewerCertificate.AcmCertificateArn).toBe(DEDICATED.appUiCertArn);
    const recs = Object.values(t.findResources("AWS::Route53::RecordSet")) as any[];
    expect(recs.filter((r) => r.Properties.Name === "example-ui.eu." && r.Properties.HostedZoneId === "ZUI123").map((r) => r.Properties.Type).sort()).toEqual(["A", "AAAA"]);
    expect(recs.filter((r) => r.Properties.Type === "TXT" && r.Properties.Name.startsWith("ui."))).toEqual([]);
    const csp = (Object.values(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0] as any).Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("frame-ancestors https://console.example.eu;");
    expect(csp).toContain("img-src 'self' data: blob:;");
    expect(handlerEnv(t).APP_UI_ORIGIN).toBe("https://example-ui.eu");
  });

  it("refuses a dedicated domain without its zone or a us-east-1 certificate, and a console origin with a path", () => {
    expect(() => synth({ ...APP_CONTENT, appUiFrame: "true", appUiDomain: "example-ui.eu" })).toThrow(/appUiZoneId is required/);
    expect(() => synth({ ...APP_CONTENT, appUiFrame: "true", ...DEDICATED, appUiCertArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x" })).toThrow(/us-east-1/);
    expect(() => synth({ ...APP_CONTENT, appUiFrame: "true", appUiConsoleOrigin: "https://example.eu/console" })).toThrow(/no path/);
  });
});
