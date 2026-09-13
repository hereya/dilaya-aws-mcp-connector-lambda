import { Match } from "aws-cdk-lib/assertions";
import {
  APP_CONTENT_CERT_ARN,
  APP_CONTENT_DOMAIN,
  buildAppContentTemplate,
  useAppContentEnv,
} from "./helpers";

describe("app-content host-routing (appContentDomain set)", () => {
  useAppContentEnv();

  const build = buildAppContentTemplate;

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

  // A cookie CloudFront strips is a SILENT no-op at the origin: the auth Lambda
  // sets it, the browser holds it, the Lambda never sees it again. Learned in
  // prod on 2026-09-13 — the passkey offer page redirected straight through
  // because `dilaya_at` was not in this allowlist (t_auth_passkey). The origin
  // policy is SHARED with every BYOD distribution (referenced by id), so the
  // ONE list here is the contract for both surfaces; the cache policy mirrors
  // it (CloudFront requires the origin set ⊇ the cache-key set).
  const SESSION_COOKIES = ["dilaya_id_token", "hereya_id_token", "dilaya_agent", "dilaya_at", "dilaya_last_email", "dilaya_pk"];

  it("forwards EVERY cookie the auth Lambda sets — session, passkey offer, last e-mail, device mark", () => {
    const t = build();
    t.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        CookiesConfig: { CookieBehavior: "whitelist", Cookies: Match.arrayWith(SESSION_COOKIES) },
      }),
    });
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          CookiesConfig: { CookieBehavior: "whitelist", Cookies: Match.arrayWith(SESSION_COOKIES) },
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
