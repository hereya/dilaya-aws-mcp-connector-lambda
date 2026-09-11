import { Match } from "aws-cdk-lib/assertions";
import { useConnectorTemplate } from "./helpers";

describe("per-app IAM roles (app-level isolation)", () => {
  const template = useConnectorTemplate({
    tmpPrefix: "connector-f4-",
    stackId: "F4Stack",
    projectEnv: JSON.stringify({
      dataApiUrl: "https://abc123.execute-api.eu-west-1.amazonaws.com",
      bucketName: "files-bkt",
      s3Prefix: "dep",
      awsRegion: "eu-west-1",
    }),
  });

  it("ships a permissions boundary capped to VM DATA routes + files-bucket S3 (no /admin/*, no IAM)", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "execute-api:Invoke",
            Resource: Match.arrayWith([Match.stringLikeRegexp("abc123/\\*/POST/query")]),
          }),
          Match.objectLike({ Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] }),
        ]),
      },
    });
    // the ceiling must NOT reach the VM admin routes
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("/admin/delete-app");
    expect(json).not.toContain("POST/admin");
  });

  it("caps per-app SSM to own-app mail/secrets params (+ KMS decrypt via SSM only)", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.arrayWith([
              Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*/mail/\\*"),
              Match.stringLikeRegexp("parameter/dilaya/\\*/apps/\\*/secrets/\\*"),
            ]),
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
            Resource: "*",
            Condition: {
              StringEquals: { "kms:ViaService": Match.stringLikeRegexp("ssm\\..*\\.amazonaws\\.com") },
            },
          }),
        ]),
      },
    });
    // the mail/secrets ceiling must NOT open agent or telegram SSM paths
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("apps/*/telegram/*");
    expect(json).not.toContain("apps/*/agent");
  });

  it("lets the connector CreateRole ONLY under /dilaya-app/ AND only with the boundary attached", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "iam:CreateRole",
            Resource: Match.stringLikeRegexp("role/dilaya-app/\\*"),
            Condition: { StringEquals: Match.objectLike({ "iam:PermissionsBoundary": Match.anyValue() }) },
          }),
        ]),
      },
    });
  });

  it("passes per-app roles to Lambda only", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "iam:PassRole",
            Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
          }),
        ]),
      },
    });
  });

  it("wires the boundary ARN + role path to the connector and drops APP_LAMBDA_ROLE_ARN", () => {
    const t = template();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          APP_LAMBDA_ROLE_PATH: "/dilaya-app/",
          APP_LAMBDA_PERMISSIONS_BOUNDARY_ARN: Match.anyValue(),
        }),
      },
    });
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("APP_LAMBDA_ROLE_ARN");
  });
});
