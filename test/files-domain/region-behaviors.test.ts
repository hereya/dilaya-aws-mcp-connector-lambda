import { Template } from "aws-cdk-lib/assertions";
import { BUCKET, CA, ENABLED, HOME_PREFIX, US, entry, synthWith } from "./helpers";

// filesRegionOrigins on the files distribution: three behaviors per region,
// appended after the two fixed ones, each the twin of the behavior it mirrors.
// Read off the SYNTHESISED template, like the rest of this folder.

const configOf = (t: Template) =>
  (Object.values(t.findResources("AWS::CloudFront::Distribution"))[0] as any).Properties.DistributionConfig;
const functionsOf = (t: Template) => t.findResources("AWS::CloudFront::Function") as Record<string, any>;
const without = (o: any, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const behavior = (config: any, pattern: string) => (config.CacheBehaviors as any[]).find((b) => b.PathPattern === pattern);
const originOf = (config: any, b: any) => (config.Origins as any[]).find((o) => o.Id === b.TargetOriginId);

/** CloudFront's path pattern match: `*` any run of characters, `?` exactly one, case-sensitive. */
const matches = (pattern: string, path: string) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(path);
/** The behavior CloudFront picks: the FIRST matching pattern in listed order, else the default. */
const route = (config: any, path: string): string =>
  ((config.CacheBehaviors as any[]).find((b) => matches(b.PathPattern, path)) ?? { PathPattern: "(default)" }).PathPattern;

describe("files distribution with filesRegionOrigins", () => {
  let base: any;
  let one: Template;
  let config: any;
  beforeAll(() => {
    base = configOf(synthWith(ENABLED));
    one = synthWith({ ...ENABLED, filesRegionOrigins: entry(CA) });
    config = configOf(one);
  });

  it("leaves the default behavior, the two fixed behaviors and their origins exactly as they were", () => {
    expect(config.DefaultCacheBehavior).toEqual(base.DefaultCacheBehavior);
    expect(config.CacheBehaviors.slice(0, 2)).toEqual(base.CacheBehaviors);
    expect(config.Origins.slice(0, 2)).toEqual(base.Origins);
    for (const k of ["Aliases", "ViewerCertificate", "Comment", "HttpVersion", "IPV6Enabled", "Enabled"]) {
      expect(config[k]).toEqual(base[k]);
    }
  });

  it("appends exactly three behaviors and two origins for the region", () => {
    expect((config.CacheBehaviors as any[]).map((b) => b.PathPattern)).toEqual([
      "/_transfer*", "/_t", "/_t/ca-central-1", "/_u/ca-central-1", "/p-ca/*",
    ]);
    expect(config.Origins).toHaveLength(4);
  });

  it("/<prefix>/* is the default behavior's twin on the region's bucket — what keeps a presigned signature valid", () => {
    const b = behavior(config, `/${CA.prefix}/*`);
    expect(without(b, "PathPattern", "TargetOriginId")).toEqual(without(config.DefaultCacheBehavior, "TargetOriginId"));
    expect(b.FunctionAssociations).toBeUndefined();
    expect(b.LambdaFunctionAssociations).toBeUndefined();
    const origin = originOf(config, b);
    const home = originOf(config, config.DefaultCacheBehavior);
    // The host S3 sees is the bucket the region's pod signed for.
    expect(origin.DomainName).toBe(CA.bucketDomain);
    expect(without(origin, "Id", "DomainName")).toEqual(without(home, "Id", "DomainName"));
    expect(origin.OriginAccessControlId).toBeUndefined();
    expect(origin.S3OriginConfig.OriginAccessIdentity).toBe("");
    expect(origin.OriginCustomHeaders).toBeUndefined();
  });

  it("adds no OAC, no OAI and no bucket policy: the signature still authorizes", () => {
    one.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
    one.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    one.resourceCountIs("AWS::S3::BucketPolicy", 0);
  });

  const runAssociated = (b: any, uri: string) => {
    expect(b.FunctionAssociations).toHaveLength(1);
    expect(b.FunctionAssociations[0].EventType).toBe("viewer-request");
    const id = b.FunctionAssociations[0].FunctionARN["Fn::GetAtt"][0];
    const fn = functionsOf(one)[id];
    expect(fn.Properties.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${fn.Properties.FunctionCode}\nreturn handler;`)()({ request: { method: "POST", uri, querystring: {}, headers: {} } });
  };

  it("/_u/<region> goes to the SAME bucket origin, the URI rewritten to / (the form POST)", () => {
    const b = behavior(config, "/_u/ca-central-1");
    expect(b.TargetOriginId).toBe(behavior(config, "/p-ca/*").TargetOriginId);
    expect(without(b, "PathPattern", "TargetOriginId", "FunctionAssociations")).toEqual(without(config.DefaultCacheBehavior, "TargetOriginId"));
    expect(runAssociated(b, "/_u/ca-central-1")).toEqual({ method: "POST", uri: "/", querystring: {}, headers: {} });
  });

  it("/_t/<region> mirrors /_t on the region's own pod host, the URI rewritten to /_t", () => {
    const b = behavior(config, "/_t/ca-central-1");
    const home = behavior(config, "/_t");
    expect(without(b, "PathPattern", "TargetOriginId", "FunctionAssociations")).toEqual(without(home, "PathPattern", "TargetOriginId"));
    const origin = originOf(config, b);
    expect(origin.DomainName).toBe(CA.host);
    expect(without(origin, "Id", "DomainName")).toEqual(without(originOf(config, home), "Id", "DomainName"));
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    expect(runAssociated(b, "/_t/ca-central-1").uri).toBe("/_t");
  });

  it("shares the two rewrite functions between regions: three functions whatever the count", () => {
    expect(Object.keys(functionsOf(one))).toHaveLength(3);
    const two = synthWith({ ...ENABLED, filesRegionOrigins: `${entry(CA)},${entry(US)}` });
    expect(Object.keys(functionsOf(two))).toHaveLength(3);
    const c2 = configOf(two);
    expect((c2.CacheBehaviors as any[]).map((b) => b.PathPattern)).toEqual([
      "/_transfer*", "/_t", "/_t/ca-central-1", "/_u/ca-central-1", "/p-ca/*", "/_t/us-east-2", "/_u/us-east-2", "/p-us/*",
    ]);
    expect(c2.Origins).toHaveLength(6);
    expect(originOf(c2, behavior(c2, "/p-us/*")).DomainName).toBe(US.bucketDomain);
    expect(originOf(c2, behavior(c2, "/_t/us-east-2")).DomainName).toBe(US.host);
    // The first region's behaviors do not move when a second one is added.
    expect(c2.CacheBehaviors.slice(0, 5)).toEqual(config.CacheBehaviors);
  });

  // Precedence. CloudFront takes the first matching pattern in listed order, so
  // a new pattern could shadow an old one only by matching a path the old one
  // matched. None does: every path below matches AT MOST one pattern, hence the
  // order decides nothing.
  describe("path precedence", () => {
    const two = () => configOf(synthWith({ ...ENABLED, filesRegionOrigins: `${entry(CA)},${entry(US)}` }));
    const PATHS: Array<[string, string]> = [
      // what existed before keeps its behavior...
      ["/_transfer", "/_transfer*"],
      ["/_transfer/", "/_transfer*"],
      ["/_transferX", "/_transfer*"],
      ["/_t", "/_t"],
      ["/", "(default)"],
      [`/${HOME_PREFIX}/org/app/a.pdf`, "(default)"],
      [`/${HOME_PREFIX}/org/_t/ca-central-1`, "(default)"],
      [`/${HOME_PREFIX}/p-ca/a.pdf`, "(default)"],
      // ...the region's paths take theirs...
      ["/_t/ca-central-1", "/_t/ca-central-1"],
      ["/_u/ca-central-1", "/_u/ca-central-1"],
      ["/p-ca/org/app/a.pdf", "/p-ca/*"],
      ["/p-ca/", "/p-ca/*"],
      ["/p-us/org/app/a.pdf", "/p-us/*"],
      ["/_u/us-east-2", "/_u/us-east-2"],
      // ...and near misses fall to the default (the home bucket, where S3 refuses them).
      ["/p-ca", "(default)"],
      ["/p-cax/a.pdf", "(default)"],
      ["/P-CA/a.pdf", "(default)"],
      ["/x/p-ca/a.pdf", "(default)"],
      ["/_t/", "(default)"],
      ["/_t/ca-central-1/", "(default)"],
      ["/_t/ca-central-1x", "(default)"],
      ["/_t/eu-west-1", "(default)"],
      ["/_u", "(default)"],
      ["/_u/", "(default)"],
      ["/_u/eu-west-1", "(default)"],
      ["/_u/ca-central-1/x", "(default)"],
    ];

    it.each(PATHS)("%s -> %s", (path, expected) => {
      const c = two();
      expect(route(c, path)).toBe(expected);
      expect((c.CacheBehaviors as any[]).filter((b) => matches(b.PathPattern, path)).length).toBeLessThanOrEqual(1);
    });

    it("routes every pre-existing path exactly as the distribution without the parameter does", () => {
      const c = two();
      for (const [path] of PATHS.slice(0, 8)) expect(route(c, path)).toBe(route(base, path));
    });

    it("gives the same routing in ANY order of the behaviors", () => {
      const c = two();
      const reversed = { CacheBehaviors: [...c.CacheBehaviors].reverse() };
      for (const [path, expected] of PATHS) expect(route(reversed, path)).toBe(expected);
    });
  });
});

describe("filesRegionOrigins refused at synth", () => {
  it.each([
    ["without filesDomain", { filesDomain: undefined, filesRegionOrigins: entry(CA) }, /filesRegionOrigins requires filesDomain/],
    ["malformed", { filesRegionOrigins: "ca-central-1:app-ca.example.eu" }, /filesRegionOrigins: .* is not <region>:<host>/],
    ["the stack's own region", { filesRegionOrigins: entry({ ...CA, region: "eu-west-1", bucketDomain: "b-eu.s3.eu-west-1.amazonaws.com" }) }, /own region/],
    ["the pod's own storage prefix", { filesRegionOrigins: entry({ ...CA, prefix: HOME_PREFIX }) }, /own storage prefix/],
    ["no storage prefix on the pod", { hereyaProjectEnv: JSON.stringify({ bucketName: BUCKET }), filesRegionOrigins: entry(CA) }, /s3Prefix/],
  ])("%s", (_name, override, message) => {
    expect(() => synthWith({ ...ENABLED, ...override })).toThrow(message);
  });
});
