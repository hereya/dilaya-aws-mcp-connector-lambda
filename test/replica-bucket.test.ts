import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// Région CA P2 lot 3 (t_rca_p2_migrate, option a): the main connector Lambda —
// and ONLY it — reaches its pod's SQLite replica bucket. Read on the primary
// (the source of an org move; also a single-region deployment), write/delete/
// abort-multipart (+ HeadObject's s3:GetObject) on the secondary (the target).
const BUCKET = "p-test-replicabucketb570b599-abcdef";
const ARN = `arn:aws:s3:::${BUCKET}`;
const BASE = { customDomain: "app.dilaya.eu", customDomainZone: "dilaya.eu" };
const EU = { ...BASE, wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x" };
const CA = {
  ...BASE,
  wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/x",
  originDomain: "app-ca.dilaya.eu",
  skipGlobalResources: "true",
};
const PROJECT = {
  sqliteReplicaBucketName: BUCKET,
  bucketName: "dilaya-files",
  capabilitySecretArn: "secret://cap",
  userPoolId: "eu-west-1_ABCDEFGHI",
  userPoolClientId: "1h57kf5cpq17m0eml12example",
};

let root: string;
const saved = { ...process.env };
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-replica-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function synth(env: Record<string, string>, project: Record<string, string> = PROJECT, region = "eu-west-1"): Template {
  process.env = { ...saved, hereyaProjectRootDir: root, oauthServerUrl: "https://dilaya.eu/oauth/connect" };
  process.env.hereyaProjectEnv = JSON.stringify(project);
  Object.assign(process.env, env);
  const stack = new DilayaConnectorLambdaStack(new cdk.App(), "Replica", { env: { account: "123456789012", region } });
  return Template.fromStack(stack);
}

/** Every statement attached (inline or overflow) to the roles `match` selects by logical id. */
function roleStatements(t: Template, match: (roleId: string) => boolean): any[] {
  const policies = [
    ...Object.values(t.findResources("AWS::IAM::Policy")),
    ...Object.values(t.findResources("AWS::IAM::ManagedPolicy")),
  ] as any[];
  return policies
    .filter((p) => (p.Properties.Roles ?? []).some((r: any) => match(String(r.Ref))))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}
const isHandler = (id: string) => id.startsWith("HandlerServiceRole");
const onReplica = (s: any[]) => s.filter((x) => JSON.stringify(x.Resource).includes(BUCKET));

describe("replica bucket grant (connector Lambda only)", () => {
  it("primary pod: ListBucket on the bucket + GetObject on its objects, nothing else", () => {
    expect(onReplica(roleStatements(synth(EU), isHandler))).toEqual([
      { Action: "s3:ListBucket", Effect: "Allow", Resource: ARN },
      { Action: "s3:GetObject", Effect: "Allow", Resource: `${ARN}/*` },
    ]);
  });

  it("secondary pod: ListBucket + Get(Head)/Put/Delete/AbortMultipartUpload on its objects", () => {
    expect(onReplica(roleStatements(synth(CA, PROJECT, "ca-central-1"), isHandler))).toEqual([
      { Action: "s3:ListBucket", Effect: "Allow", Resource: ARN },
      {
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Effect: "Allow",
        Resource: `${ARN}/*`,
      },
    ]);
  });

  it.each([
    ["primary", EU, "eu-west-1"],
    ["secondary", CA, "ca-central-1"],
  ])("%s pod: no other role (auth Lambda, authorizers, app roles…) gets the bucket", (_n, env, region) => {
    const t = synth(env as Record<string, string>, PROJECT, region as string);
    const others = roleStatements(t, (id) => !isHandler(id));
    expect(others.length).toBeGreaterThan(0);
    expect(onReplica(others)).toEqual([]);
    for (const id of ["FrontendAuthorizerHandlerServiceRole", "AuthLambdaHandlerServiceRole", "AuthorizerHandlerServiceRole"]) {
      expect(Object.keys(t.findResources("AWS::IAM::Role")).some((r) => r.startsWith(id))).toBe(true);
    }
    const all = [...Object.values(t.findResources("AWS::IAM::Policy")), ...Object.values(t.findResources("AWS::IAM::ManagedPolicy"))] as any[];
    const notHandler = all.filter((p) => !(p.Properties.Roles ?? []).some((r: any) => isHandler(String(r.Ref))));
    expect(JSON.stringify(notHandler)).not.toContain(BUCKET); // incl. the app-Lambda boundary
  });

  it("is inert without the bucket name and on a legacy single-org deployment", () => {
    const { sqliteReplicaBucketName: _b, ...noBucket } = PROJECT;
    expect(JSON.stringify(synth(EU, noBucket).toJSON())).not.toContain(BUCKET);
    expect(onReplica(roleStatements(synth({ ...EU, organizationId: "88120129-295f-476c-b1e1-382ecbc7381a" }), isHandler))).toEqual([]);
  });

  it("refuses a value that is not a bucket name", () => {
    expect(() => synth(EU, { ...PROJECT, sqliteReplicaBucketName: "arn:aws:s3:::x" })).toThrow(/must be an S3 bucket name/);
  });
});
