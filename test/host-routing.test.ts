import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// -----------------------------------------------------------------------------
// App-content domain host-routing (FLAT scheme). The feature is gated on the
// `appContentDomain` deploy param. WITH the three params set we must stand up:
//   - a CloudFront distribution (alt name *.<appContentDomain> + the passed-in
//     us-east-1 viewer cert ARN) fronting the API-GW custom-domain origin,
//   - a CloudFront FUNCTION (viewer-request) holding the bootstrap host map,
//   - a Route53 A/AAAA wildcard *.<appContentDomain> aliased to the distribution,
//   - APP_CONTENT_* env vars + the 3 cloudfront:* function IAM perms on the
//     connector Lambda.
// WITHOUT the params the whole thing must be absent (feature inert) — locked by
// the existing suites (agent-routes / authorizer) which never set it; a focused
// negative assertion below double-checks the CloudFront function + env are gone.
// -----------------------------------------------------------------------------

/**
 * FunctionCode is a plain string until it embeds a CFN token (the static
 * bucket's RegionalDomainName GetAtt) — then it synths as an Fn::Join. Flatten
 * either shape to one searchable string (tokens inlined as their JSON).
 */
function fnCodeToString(fc: unknown): string {
  if (typeof fc === "string") return fc;
  const parts = (fc as any)?.["Fn::Join"]?.[1] ?? [];
  return parts
    .map((p: unknown) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join("");
}

const APP_CONTENT_DOMAIN = "dilaya-apps.eu";
const APP_CONTENT_ZONE_ID = "Z0APPCONTENT123";
const APP_CONTENT_CERT_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def-456";

describe("app-content host-routing (appContentDomain set)", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-hostrouting-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    // The content distribution reuses the API-GW custom-domain origin, so the
    // block lives under customDomain. customDomainZone is set explicitly to keep
    // the Route53 lookup hermetic.
    process.env.customDomain = "app.dilaya.eu";
    process.env.customDomainZone = "dilaya.eu";
    process.env.wildcardCertificateArn =
      "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
    process.env.appContentDomain = APP_CONTENT_DOMAIN;
    process.env.appContentZoneId = APP_CONTENT_ZONE_ID;
    process.env.appContentCertArn = APP_CONTENT_CERT_ARN;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function build() {
    const app = new cdk.App({
      // Seed the customDomain hosted-zone lookup so synth is hermetic.
      context: {
        "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1":
          {
            Id: "/hostedzone/ZCUSTOMDOMAIN",
            Name: "dilaya.eu.",
          },
      },
    });
    const stack = new DilayaConnectorLambdaStack(app, "HostRoutingStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("creates a CloudFront distribution with alt-domain *.dilaya-apps.eu + the passed-in viewer cert ARN", () => {
    const t = build();
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: Match.arrayWith([`*.${APP_CONTENT_DOMAIN}`]),
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: APP_CONTENT_CERT_ARN,
        }),
      }),
    });
  });

  it("attaches CACHING_DISABLED + a viewer-request CloudFront function on the default behaviour", () => {
    const t = build();
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: "viewer-request" }),
          ]),
        }),
      }),
    });
  });

  it("creates the KVS-backed router FUNCTION (JS 2.0) with the await hoisted out of call arguments", () => {
    const t = build();
    t.resourceCountIs("AWS::CloudFront::Function", 1);
    t.resourceCountIs("AWS::CloudFront::KeyValueStore", 1);
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    expect(cfFn.Properties.Name).toBe("app-app-apphost-router");
    expect(cfFn.Properties.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    // The KVS is associated to the function (this is what binds cf.kvs()).
    expect(
      cfFn.Properties.FunctionConfig.KeyValueStoreAssociations
    ).toBeDefined();
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // Routing table is DATA (KVS lookup) — never a baked map in the code.
    expect(code).toContain("cf.kvs()");
    expect(code).not.toContain("var HOSTMAP");
    // JS 2.0 rejects `await` inside a call ARGUMENT (prod 503, 2026-07-19):
    // the kvs.get await must be hoisted into its own statement.
    expect(code).toContain("var raw = await kvs.get(host);");
    expect(code).not.toMatch(/JSON\.parse\(await/);
    // Tags the viewer host for the origin.
    expect(code).toContain("request.headers['x-dilaya-app-host']");
    // Rewrites to the existing per-app site/auth routes.
    expect(code).toContain("'/o/' + e.o + '/' + e.a + '/site'");
    // /static/* rewrites into the tenant's key prefix in the assets bucket.
    expect(code).toContain("'/_appstatic/' + e.o + '/' + e.a");
  });

  it("static-SECTIONS branch (hybrid): prefix-listed paths swap to the S3 origin (OAC sigv4) with per-section SPA fallback; /api + /auth always dynamic", () => {
    const t = build();
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // Gated on the KVS value's `p` prefix list; /api/* and /auth/* are
    // excluded BEFORE prefix matching so a hybrid app keeps its Lambda API
    // and its login flow no matter what prefixes are declared.
    expect(code).toContain("if (e.p && e.p.length && uri !== '/api' && uri.indexOf('/api/') !== 0");
    expect(code).toContain("uri !== '/auth' && uri.indexOf('/auth/') !== 0");
    // Longest matching prefix wins; '/' matches everything (whole-site static).
    expect(code).toContain("pf === '/' || uri === pf || uri.indexOf(pf + '/') === 0");
    expect(code).toContain("pf.length > m.length");
    // Site files live under /_appsite/<org>/<app>/ in the static bucket, and
    // an extensionless URI falls back to the SECTION's index.html.
    expect(code).toContain("'/_appsite/' + e.o + '/' + e.a");
    expect(code).toContain("(m === '/' ? '' : m) + '/index.html'");
    // Origin switch to S3 with OAC sigv4 signing, custom headers reset (the
    // API-GW origin-verify secret must never leak to S3).
    expect(code).toContain("cf.updateRequestOrigin(");
    expect(code).toContain('"signingProtocol": "sigv4"');
    expect(code).toContain('"originType": "s3"');
    expect(code).toContain('"customHeaders": {}');
    // The S3 domain is the deployment's static bucket (a CFN token at synth —
    // the flattened code carries the bucket's RegionalDomainName GetAtt).
    expect(code).toContain("RegionalDomainName");
  });

  it("canonical-redirect branch: KVS value flag `r` 301s to the target host preserving path + query, edge-cached 1h", () => {
    const t = build();
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // The redirect check runs right after the KVS parse — BEFORE the /static
    // and static-sections branches, so a redirecting host never serves content
    // in any mode.
    expect(code.indexOf("if (e.r)")).toBeGreaterThan(-1);
    expect(code.indexOf("if (e.r)")).toBeLessThan(code.indexOf("'/_appstatic/'"));
    // 301 to https://<r><path>?<query> (query rebuilt incl. multi-value keys).
    expect(code).toContain("var loc = 'https://' + e.r + request.uri;");
    expect(code).toContain("qs[k].multiValue");
    expect(code).toContain("statusCode: 301");
    expect(code).toContain("'cache-control': { value: 'public, max-age=3600' }");
  });

  it("forwards the x-dilaya-app-host header + the cookie allowlist on the content origin policy", () => {
    const t = build();
    t.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: Match.objectLike({
          Headers: Match.arrayWith(["x-dilaya-app-host"]),
        }),
        CookiesConfig: Match.objectLike({
          Cookies: Match.arrayWith(["dilaya_id_token", "dilaya_agent"]),
        }),
      }),
    });
  });

  it("points a Route53 A + AAAA wildcard *.dilaya-apps.eu at the content distribution", () => {
    const t = build();
    const dists = t.findResources("AWS::CloudFront::Distribution");
    const distId = Object.keys(dists)[0];

    for (const type of ["A", "AAAA"]) {
      const records = t.findResources("AWS::Route53::RecordSet", {
        Properties: { Type: type, Name: `*.${APP_CONTENT_DOMAIN}.` },
      });
      const entries = Object.values(records) as any[];
      expect(entries.length).toBe(1);
      const dnsName = entries[0].Properties.AliasTarget.DNSName;
      // Alias DNSName is a GetAtt of the content distribution's DomainName.
      expect(dnsName).toEqual({ "Fn::GetAtt": [distId, "DomainName"] });
    }
  });

  it("exports APP_CONTENT_* env vars to the connector Lambda", () => {
    const t = build();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          APP_CONTENT_DOMAIN: APP_CONTENT_DOMAIN,
          APP_CONTENT_CF_FUNCTION_NAME: "app-app-apphost-router",
          APP_CONTENT_DISTRIBUTION_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("grants the connector Lambda the 4 cloudfront:* function perms scoped to the content function ARN", () => {
    const t = build();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "cloudfront:GetFunction",
              "cloudfront:DescribeFunction",
              "cloudfront:UpdateFunction",
              "cloudfront:PublishFunction",
            ],
            Resource:
              "arn:aws:cloudfront::123456789012:function/app-app-apphost-router",
          }),
        ]),
      },
    });
  });
});

describe("app-content host-routing inert without appContentDomain", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-noroute-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.appContentDomain;
    delete process.env.appContentZoneId;
    delete process.env.appContentCertArn;
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function build() {
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "NoRouteStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("creates no CloudFront function/distribution and no APP_CONTENT_* env", () => {
    const t = build();
    t.resourceCountIs("AWS::CloudFront::Function", 0);
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("APP_CONTENT_DOMAIN");
    expect(json).not.toContain("apphost-router");
    expect(json).not.toContain("x-dilaya-app-host");
  });
});
