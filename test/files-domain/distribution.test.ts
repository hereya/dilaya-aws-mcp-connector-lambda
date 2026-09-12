import * as fs from "fs";
import * as path from "path";
import { Template } from "aws-cdk-lib/assertions";
import {
  BUCKET,
  ENABLED,
  FILES_CERT_ARN,
  FILES_DOMAIN,
  PKG_ROOT,
  readLibSources,
  synthWith,
} from "./helpers";

// Managed policy ids, as AWS publishes them. Asserted by id rather than through
// the CDK constants so a swapped constant in the stack cannot pass by agreeing
// with itself.
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

describe("files domain (filesDomain set)", () => {
  let t: Template;
  let config: any;
  beforeAll(() => {
    t = synthWith(ENABLED);
    const dists = Object.values(t.findResources("AWS::CloudFront::Distribution"));
    expect(dists).toHaveLength(1);
    config = (dists[0] as any).Properties.DistributionConfig;
  });

  it("answers on filesDomain with the passed-in us-east-1 certificate", () => {
    expect(config.Aliases).toEqual([FILES_DOMAIN]);
    expect(config.ViewerCertificate.AcmCertificateArn).toBe(FILES_CERT_ARN);
    expect(config.ViewerCertificate.SslSupportMethod).toBe("sni-only");
  });

  it("relays to the file bucket's REGIONAL endpoint — the host the connector presigns for", () => {
    expect(config.Origins).toHaveLength(1);
    expect(JSON.stringify(config.Origins[0].DomainName)).toContain(`${BUCKET}.s3.eu-west-1.`);
  });

  it("carries no OAC/OAI and no bucket policy: the signature in the query string authorizes", () => {
    const origin = config.Origins[0];
    expect(origin.OriginAccessControlId).toBeUndefined();
    expect(origin.S3OriginConfig?.OriginAccessIdentity ?? "").toBe("");
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
    t.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    t.resourceCountIs("AWS::S3::BucketPolicy", 0);
  });

  it("forwards everything but Host, caches nothing, allows uploads, refuses plain http", () => {
    const b = config.DefaultCacheBehavior;
    expect(b.CachePolicyId).toBe(CACHING_DISABLED);
    expect(b.OriginRequestPolicyId).toBe(ALL_VIEWER_EXCEPT_HOST);
    expect(b.AllowedMethods).toEqual(expect.arrayContaining(["GET", "HEAD", "PUT", "POST"]));
    expect(b.ViewerProtocolPolicy).toBe("https-only");
  });

  it("points A + AAAA filesDomain at the distribution", () => {
    const distId = Object.keys(t.findResources("AWS::CloudFront::Distribution"))[0];
    for (const type of ["A", "AAAA"]) {
      const records = Object.values(
        t.findResources("AWS::Route53::RecordSet", {
          Properties: { Type: type, Name: `${FILES_DOMAIN}.` },
        })
      ) as any[];
      expect(records).toHaveLength(1);
      expect(records[0].Properties.AliasTarget.DNSName).toEqual({
        "Fn::GetAtt": [distId, "DomainName"],
      });
    }
  });

  it("tells the connector Lambda which host to hand out", () => {
    const withHost = Object.values(t.findResources("AWS::Lambda::Function")).filter(
      (f: any) => f.Properties.Environment?.Variables?.FILES_PUBLIC_HOST
    ) as any[];
    expect(withHost).toHaveLength(1);
    expect(withHost[0].Properties.Environment.Variables.FILES_PUBLIC_HOST).toBe(FILES_DOMAIN);
  });
});

describe("files domain inert without filesDomain", () => {
  it("creates no distribution and no FILES_PUBLIC_HOST", () => {
    const t = synthWith({ hereyaProjectEnv: ENABLED.hereyaProjectEnv });
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
    expect(JSON.stringify(t.toJSON())).not.toContain("FILES_PUBLIC_HOST");
  });
});

describe("files domain refuses a half configuration", () => {
  it.each([
    ["filesCertArn", { filesCertArn: undefined }],
    ["filesZoneId", { filesZoneId: undefined }],
    ["bucketName", { hereyaProjectEnv: "{}" }],
  ])("without %s", (name, override) => {
    expect(() => synthWith({ ...ENABLED, ...override })).toThrow(name);
  });
});

// The names are the contract with the connector's release.yml. A package only
// receives an input it DECLARES; an undeclared one is dropped in silence while
// the deploy goes green (2026-08-07, three releases that created nothing).
describe("files domain input names", () => {
  it("reads and declares filesDomain / filesZoneId / filesCertArn verbatim", () => {
    const lib = readLibSources();
    const hereyarc = fs.readFileSync(path.join(PKG_ROOT, "hereyarc.yaml"), "utf8");
    for (const name of ["filesDomain", "filesZoneId", "filesCertArn"]) {
      expect(lib).toContain(`process.env["${name}"]`);
      expect(hereyarc).toMatch(new RegExp(`^ {2}${name}:$`, "m"));
    }
  });
});
