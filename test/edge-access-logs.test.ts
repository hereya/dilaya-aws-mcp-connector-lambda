import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The per-org request cap counts in the frontend authorizer, and the authorizer
// only ever runs for requests that reach the ORIGIN. Everything the edge
// answers by itself — a cache hit, and every path of a static-mode site — was
// counted by NOTHING: measured in prod on 2026-08-28, `GET /` on a static
// tenant host returned 200 with zero authorizer invocations while
// `/auth/login` and `/api/ping` on the same app counted 2 of 2.
//
// Access logs are the only place that half of the traffic exists, so these
// tests assert the WIRING that produces them: a green `cdk synth` says a
// template is well-formed, never that the distribution actually delivers logs
// anywhere (2026-08-27, a metric filter that synthesised perfectly and failed
// at CREATE). What can be pinned here is the shape — logging on, the bucket it
// writes to, the prefix the reader keys its checkpoints on, and the fact that
// the connector is told all three.
describe("edge access logs", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-edge-logs-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(env: Record<string, string> = {}): Template {
    process.env = { ...saved };
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    Object.assign(process.env, env);
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  const EDGE = {
    customDomain: "app.dilaya.eu",
    wildcardCertificateArn:
      "arn:aws:acm:eu-west-1:123456789012:certificate/99999999-8888-7777-6666-555555555555",
    appContentDomain: "dilaya-apps.eu",
    appContentZoneId: "Z0123456789ABCDEFGHIJ",
    appContentCertArn:
      "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  };

  /** The wildcard app-content distribution — the one that carries every
   *  vanity host of every org, and therefore the one whose log is the only
   *  per-ORG view of edge traffic. */
  function appContentDistribution(t: Template): any {
    const found = Object.values(
      t.findResources("AWS::CloudFront::Distribution")
    ).filter((r: any) =>
      (r.Properties?.DistributionConfig?.Aliases ?? []).some((a: string) =>
        String(a).startsWith("*.")
      )
    );
    expect(found).toHaveLength(1);
    return found[0];
  }

  it("logs the app-content distribution to a bucket, under the shared prefix", () => {
    const t = template(EDGE);
    const logging = appContentDistribution(t).Properties.DistributionConfig
      .Logging;
    expect(logging).toBeDefined();
    expect(logging.Prefix).toBe("cf/");
    // Session cookies have no part in counting a request against an org.
    expect(logging.IncludeCookies).toBe(false);
    expect(logging.Bucket).toBeDefined();
  });

  // The reader lists `<prefix><distributionId>.` and keeps ONE checkpoint per
  // distribution, which only works while every distribution shares the prefix
  // the connector is told about. If these two ever drift, the reader silently
  // finds no files and every org's edge traffic reads as zero — a failure that
  // looks exactly like "no traffic".
  it("tells the connector the same bucket and prefix it configured", () => {
    const t = template(EDGE);
    const logging = appContentDistribution(t).Properties.DistributionConfig
      .Logging;
    const fn = Object.values(t.findResources("AWS::Lambda::Function")).find(
      (r: any) => r.Properties?.Environment?.Variables?.EDGE_LOG_BUCKET
    ) as any;
    expect(fn).toBeDefined();
    const vars = fn.Properties.Environment.Variables;
    expect(vars.EDGE_LOG_PREFIX).toBe(logging.Prefix);
    expect(vars.EDGE_LOG_BUCKET_DOMAIN).toBeDefined();
    // Same bucket, not merely some bucket: the logging Bucket is the S3 domain
    // name of the very resource whose name the connector is handed.
    const bucketRef = JSON.stringify(vars.EDGE_LOG_BUCKET);
    expect(JSON.stringify(logging.Bucket)).toContain(
      JSON.parse(bucketRef).Ref ?? bucketRef
    );
  });

  // CloudFront v1 delivery writes each object with an ACL grant to the log-delivery
  // account. A bucket that refuses ACLs outright (the modern S3 default,
  // BUCKET_OWNER_ENFORCED) accepts the CloudFormation update and then delivers
  // nothing at all — the failure mode this assertion exists to prevent.
  it("keeps the log bucket able to accept the delivery ACL, and expires it", () => {
    const t = template(EDGE);
    const buckets = Object.values(t.findResources("AWS::S3::Bucket")).filter(
      (r: any) =>
        (r.Properties?.LifecycleConfiguration?.Rules ?? []).some(
          (rule: any) => rule.ExpirationInDays === 45
        )
    );
    expect(buckets).toHaveLength(1);
    const b: any = buckets[0];
    const rules = b.Properties.OwnershipControls?.Rules ?? [];
    expect(rules).toEqual([{ ObjectOwnership: "BucketOwnerPreferred" }]);
    expect(b.Properties.PublicAccessBlockConfiguration).toBeDefined();
  });

  // Without an app-content domain there is no edge layer at all, so there is
  // nothing to log and no bucket to pay for.
  it("provisions nothing when the edge layer is off", () => {
    const t = template({
      customDomain: EDGE.customDomain,
      wildcardCertificateArn: EDGE.wildcardCertificateArn,
    });
    const fn = Object.values(t.findResources("AWS::Lambda::Function")).find(
      (r: any) => r.Properties?.Environment?.Variables?.EDGE_LOG_BUCKET
    );
    expect(fn).toBeUndefined();
  });
});
