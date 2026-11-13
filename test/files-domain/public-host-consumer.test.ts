import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../../lib/dilaya-aws-mcp-connector-lambda-stack";
import { parseFilesRegionOrigins } from "../../lib/stack/files-transfer/region-origins";
import { resolvedEnvBytes } from "../helpers/env-size";

// filesPublicHost (lib/stack/files-transfer/public-host-consumer.ts): a
// SECONDARY pod emits its file links on the PRIMARY's files host. It gets the
// host's name on its connector and nothing else — the distribution, its
// behaviors and the page are the primary's (filesRegionOrigins). Every value
// here is a placeholder.
const HOST = "files.example.eu";
const BUCKET = "files-ca-test";
const PREFIX = "p-ca";
const PROJECT_ENV = JSON.stringify({ bucketName: BUCKET, s3Prefix: PREFIX });
const PRIMARY = {
  customDomain: "app.example.eu",
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  hereyaProjectEnv: PROJECT_ENV,
};
const SECONDARY = { ...PRIMARY, originDomain: "app-ca.example.eu", skipGlobalResources: "true" };
const FILES_DOMAIN = { filesDomain: HOST, filesZoneId: "ZFILES123", filesCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/f" };

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-files-consumer-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://example.eu/oauth/connect" };
  for (const k of ["filesPublicHost", "filesDomain", "filesZoneId", "filesCertArn", "filesRegionOrigins", "organizationId"]) delete process.env[k];
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "FilesConsumer", {
    env: { account: "123456789012", region: "ca-central-1" },
  });
  return Template.fromStack(stack);
}
const handlerEnv = (t: Template): Record<string, unknown> =>
  (Object.values(t.findResources("AWS::Lambda::Function")) as any[]).find(
    (f) => f.Properties.Environment?.Variables?.customDomain !== undefined
  ).Properties.Environment.Variables;

describe("secondary pod on the primary's files host (filesPublicHost)", () => {
  let off: Template;
  let on: Template;
  beforeAll(() => {
    off = synth(SECONDARY);
    on = synth({ ...SECONDARY, filesPublicHost: HOST });
  });

  it("puts the host on the connector, on that function only", () => {
    expect(handlerEnv(on).FILES_PUBLIC_HOST).toBe(HOST);
    const carriers = (Object.values(on.findResources("AWS::Lambda::Function")) as any[]).filter(
      (f) => f.Properties.Environment?.Variables?.FILES_PUBLIC_HOST !== undefined
    );
    expect(carriers).toHaveLength(1);
  });

  it("creates no resource: the template differs by that one variable and one output", () => {
    const a = off.toJSON();
    const b = on.toJSON();
    expect(Object.keys(b.Resources)).toEqual(Object.keys(a.Resources));
    expect(Object.keys(b.Outputs)).toEqual([...Object.keys(a.Outputs), "FilesRegionOrigin"]);
    // Strip the two additions: what is left is the pod without the parameter.
    const stripped = JSON.parse(JSON.stringify(b));
    delete stripped.Outputs.FilesRegionOrigin;
    for (const r of Object.values(stripped.Resources) as any[]) delete r.Properties?.Environment?.Variables?.FILES_PUBLIC_HOST;
    expect(stripped).toEqual(a);
    for (const type of ["AWS::CloudFront::Distribution", "AWS::CloudFront::Function", "AWS::Route53::RecordSet", "AWS::S3::BucketPolicy"]) {
      expect(Object.keys(on.findResources(type))).toEqual(Object.keys(off.findResources(type)));
    }
  });

  it("publishes the exact entry the primary's filesRegionOrigins takes for this pod", () => {
    const value = on.toJSON().Outputs.FilesRegionOrigin.Value;
    expect(value).toBe(`ca-central-1:app-ca.example.eu:${BUCKET}.s3.ca-central-1.amazonaws.com:${PREFIX}`);
    // ...and the primary's own parser accepts it as is.
    expect(parseFilesRegionOrigins(value, { region: "eu-west-1", prefix: "p-eu" })).toEqual([
      { region: "ca-central-1", host: "app-ca.example.eu", bucketDomain: `${BUCKET}.s3.ca-central-1.amazonaws.com`, prefix: PREFIX },
    ]);
  });

  it("without the parameter: no variable, no output", () => {
    expect(handlerEnv(off).FILES_PUBLIC_HOST).toBeUndefined();
    expect(off.toJSON().Outputs.FilesRegionOrigin).toBeUndefined();
  });

  it("weighs its key and value on the Lambda environment, nothing more", () => {
    const bytes = (t: Template) => resolvedEnvBytes(handlerEnv(t), t.toJSON().Resources);
    expect(bytes(on) - bytes(off)).toBe("FILES_PUBLIC_HOST".length + HOST.length + 6); // "k":"v",
  });

  it("is refused on a primary pod, which names its files host with filesDomain", () => {
    expect(() => synth({ ...PRIMARY, filesPublicHost: HOST })).toThrow(/filesPublicHost: is for a SECONDARY pod/);
    expect(() => synth({ ...PRIMARY, originDomain: "app-ca.example.eu", filesPublicHost: HOST })).toThrow(/is for a SECONDARY pod/);
  });

  it("is refused together with filesDomain, on either kind of pod", () => {
    expect(() => synth({ ...PRIMARY, ...FILES_DOMAIN, filesPublicHost: HOST })).toThrow(/filesPublicHost: cannot be set with filesDomain/);
    // On a secondary pod filesDomain itself stays refused, before anything else.
    expect(() => synth({ ...SECONDARY, ...FILES_DOMAIN, filesPublicHost: HOST })).toThrow(/filesDomain is a once-per-account/);
    expect(() => synth({ ...SECONDARY, ...FILES_DOMAIN })).toThrow(/filesDomain is a once-per-account/);
  });

  it.each([
    ["a scheme", "https://files.example.eu"],
    ["a path", "files.example.eu/_transfer"],
    ["a trailing slash", "files.example.eu/"],
    ["a port", "files.example.eu:443"],
    ["an upper-case letter", "Files.example.eu"],
    ["a single label", "files"],
    ["a trailing dot", "files.example.eu."],
    ["a leading dot", ".example.eu"],
    ["a wildcard", "*.example.eu"],
    ["a space", "files.example.eu "],
    ["an underscore", "files_ca.example.eu"],
    ["a query", "files.example.eu?x"],
    ["two hosts", "files.example.eu,files2.example.eu"],
    ["a label ending in a dash", "files-.example.eu"],
    ["more than 253 characters", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.eu`],
  ])("refuses a host with %s", (_name, host) => {
    expect(() => synth({ ...SECONDARY, filesPublicHost: host })).toThrow(/filesPublicHost: must be a bare lowercase DNS name/);
  });

  it("refuses one of the pod's own API names: the files host is another host", () => {
    expect(() => synth({ ...SECONDARY, filesPublicHost: "app-ca.example.eu" })).toThrow(/not one of this pod's API names/);
    expect(() => synth({ ...SECONDARY, filesPublicHost: "app.example.eu" })).toThrow(/not one of this pod's API names/);
  });

  it("refuses a pod the primary could not route: no bucket, no storage prefix, or a prefix that is not one plain segment", () => {
    const withEnv = (o: Record<string, string>) => synth({ ...SECONDARY, filesPublicHost: HOST, hereyaProjectEnv: JSON.stringify(o) });
    expect(() => withEnv({ s3Prefix: PREFIX })).toThrow(/filesPublicHost: hereyaProjectEnv carries no bucketName/);
    expect(() => withEnv({ bucketName: BUCKET })).toThrow(/filesPublicHost: the pod's storage prefix/);
    for (const prefix of ["a/b", "_t", "p-*", "p.ca"]) {
      expect(() => withEnv({ bucketName: BUCKET, s3Prefix: prefix })).toThrow(/filesPublicHost: the pod's storage prefix/);
    }
  });
});
