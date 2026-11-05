import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import type { StackContext } from "./context";

/** The issuer's OIDC documents: public, no authorizer, answered by the connector Lambda. */
export const WIF_PUBLIC_PATHS = ["/wif/.well-known/openid-configuration", "/wif/jwks.json"] as const;

/**
 * The key the connector signs workload-identity assertions with.
 *
 * Multi-region so that every pod signs with the same key material and one JWKS
 * serves them all. The key id (`mrk-…`) is also the same everywhere, which is
 * why the connector gets the bare id in WIF_KMS_KEY_ID and passes it to KMS in
 * its own region.
 *
 *   PRIMARY pod: creates the primary key, and outputs its ARN.
 *   SECONDARY pod: with `wifKmsKeyArn` (that output), creates the replica in its
 *     own region. Without it: no key, no env, no grant.
 *
 * Retained on stack deletion and replacement: a lost key would invalidate the
 * issuer registered with the relying party.
 */
export function createWifSigning(stack: cdk.Stack, ctx: StackContext): void {
  const primaryKeyArn = process.env["wifKmsKeyArn"] || undefined;
  if (primaryKeyArn && !ctx.skipGlobalResources) {
    throw new Error("wifKmsKeyArn is for a SECONDARY pod (skipGlobalResources=true): a primary creates its own key");
  }
  const key = ctx.skipGlobalResources
    ? primaryKeyArn && createReplicaKey(stack, primaryKeyArn)
    : createPrimaryKey(stack);
  if (!key) return;

  ctx.fn.addEnvironment("WIF_KMS_KEY_ID", key.id);
  ctx.fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["kms:Sign", "kms:GetPublicKey"], resources: [key.arn] })
  );
}

interface WifKey {
  id: string;
  arn: string;
}

const DESCRIPTION = "Signs the connector's workload-identity assertions";
const MRK_ARN_RE = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/mrk-[0-9a-f]{32}$/;

const aliasName = (stack: cdk.Stack): string => `alias/${stack.stackName}-wif-signing`;

/** The account root administers; IAM policies grant the rest. */
function keyPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        actions: ["kms:*"],
        resources: ["*"],
        principals: [new iam.AccountRootPrincipal()],
      }),
    ],
  });
}

function createPrimaryKey(stack: cdk.Stack): WifKey {
  const key = new kms.Key(stack, "WifSigningKey", {
    description: DESCRIPTION,
    keySpec: kms.KeySpec.RSA_2048,
    keyUsage: kms.KeyUsage.SIGN_VERIFY,
    multiRegion: true,
    policy: keyPolicy(),
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  key.addAlias(aliasName(stack));
  new cdk.CfnOutput(stack, "WifKmsKeyArn", { value: key.keyArn });
  return { id: key.keyId, arn: key.keyArn };
}

function createReplicaKey(stack: cdk.Stack, primaryKeyArn: string): WifKey {
  const m = MRK_ARN_RE.exec(primaryKeyArn);
  if (!m) throw new Error(`wifKmsKeyArn must be a multi-Region KMS key ARN; got ${primaryKeyArn}`);
  if (m[1] === stack.region) {
    throw new Error(`wifKmsKeyArn must be the PRIMARY key, in another region than this pod; got ${primaryKeyArn}`);
  }
  const replica = new kms.CfnReplicaKey(stack, "WifSigningKeyReplica", {
    description: DESCRIPTION,
    keyPolicy: keyPolicy(),
    primaryKeyArn,
  });
  replica.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  new kms.CfnAlias(stack, "WifSigningKeyReplicaAlias", {
    aliasName: aliasName(stack),
    targetKeyId: replica.attrKeyId,
  });
  return { id: replica.attrKeyId, arn: replica.attrArn };
}
