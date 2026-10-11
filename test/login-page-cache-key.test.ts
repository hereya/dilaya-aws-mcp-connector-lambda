import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The login page is cached at the edge for 60 s (t_login_burst_authlambda).
// What makes that safe is the CACHE KEY: the page renders from two request
// facts beyond its query string and cookies — the vanity host (x-dilaya-app-host,
// tagged by the router function; the passkey button shows on the rpId host only)
// and Accept-Language (an app that never stored a language renders the
// browser's). Both must be in the key, or a French visitor's page is served to
// the next English one for a minute. The cookie list is the same as before.
describe("app-content cache key for a cached tenant page", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-login-cache-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.organizationId;
    Object.assign(process.env, {
      customDomain: "app.dilaya.eu",
      wildcardCertificateArn:
        "arn:aws:acm:eu-west-1:123456789012:certificate/99999999-8888-7777-6666-555555555555",
      appContentDomain: "dilaya-apps.eu",
      appContentZoneId: "Z0123456789ABCDEFGHIJ",
      appContentCertArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
    });
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  test("x-dilaya-app-host and Accept-Language are in the key; TTLs still origin-driven", () => {
    const t = template();
    const policies = t.findResources("AWS::CloudFront::CachePolicy");
    const [id, res] = Object.entries(policies).find(([k]) => k.startsWith("AppContentCachePolicy"))!;
    expect(id).toBeDefined();
    const cfg = (res as any).Properties.CachePolicyConfig;
    const key = cfg.ParametersInCacheKeyAndForwardedToOrigin;
    expect(key.HeadersConfig).toEqual({
      HeaderBehavior: "whitelist",
      Headers: ["x-dilaya-app-host", "Accept-Language"],
    });
    expect(key.QueryStringsConfig.QueryStringBehavior).toBe("all");
    expect(key.CookiesConfig.CookieBehavior).toBe("whitelist");
    expect(key.CookiesConfig.Cookies).toEqual(
      expect.arrayContaining(["dilaya_id_token", "dilaya_last_email"])
    );
    // Opt-in stays opt-in: nothing is cached unless the origin says so.
    expect(cfg.MinTTL).toBe(0);
    expect(cfg.DefaultTTL).toBe(0);
  });

  test("the origin already received both headers — the key adds no new forwarding", () => {
    const t = template();
    const [, res] = Object.entries(t.findResources("AWS::CloudFront::OriginRequestPolicy")).find(
      ([k]) => k.startsWith("AppContentOriginPolicy")
    )!;
    const headers: string[] = (res as any).Properties.OriginRequestPolicyConfig.HeadersConfig.Headers;
    const lower = headers.map((h) => h.toLowerCase());
    expect(lower).toContain("x-dilaya-app-host");
    expect(lower).toContain("accept-language");
  });
});
