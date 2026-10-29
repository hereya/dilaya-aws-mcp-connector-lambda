/**
 * Golden-template harness for the connector deploy stack.
 *
 * The split of dilaya-aws-mcp-connector-lambda-stack.ts must be a PURE MOVE:
 * every construct keeps its logical id, every property its value. Neither
 * `tsc` nor `cdk synth` proves that — only the synthesized TEMPLATE does.
 *
 * Synthesizes the stack under several env profiles (each lighting up a
 * different set of feature branches) and writes one JSON per profile.
 *
 *   npx ts-node --prefer-ts-exts scripts/synth-golden.ts <outDir>
 * (--prefer-ts-exts as in cdk.json: else stale untracked lib .js builds win over the .ts.)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: synth-golden.ts <outDir>");
fs.mkdirSync(outDir, { recursive: true });

// Deterministic asset sources: content-addressed hashes must not move between
// the before and after runs, so the bytes are fixed, not temp-random.
function makeRoot(withLayer: boolean): string {
  const root = path.join(os.tmpdir(), `connector-golden-${withLayer ? "layer" : "plain"}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "handler.js"), "exports.handler=async()=>({});");
  if (withLayer) {
    fs.mkdirSync(path.join(root, "dist", "layer", "nodejs"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "layer", "nodejs", "index.js"), "module.exports={};");
  }
  return root;
}

const POLICY = JSON.stringify({
  Statement: [
    { Effect: "Allow", Action: ["execute-api:Invoke"], Resource: "arn:aws:execute-api:eu-west-1:123456789012:abc123/*/POST/query" },
    { Effect: "Allow", Action: ["dynamodb:GetItem"], Resource: "arn:aws:dynamodb:eu-west-1:123456789012:table/registry" },
  ],
});

const BASE_PROJECT_ENV = {
  dataApiUrl: "https://abc123.execute-api.eu-west-1.amazonaws.com/prod",
  registryTableName: "registry",
  bucketName: "dilaya-files",
  s3Prefix: "apps",
  capabilitySecretArn: "secret://s3cr3t-capability-value",
  someOtherSecret: "secret://another-value",
  IAM_POLICY_sqlite: POLICY,
};

const COGNITO_ENV = { userPoolId: "eu-west-1_ABCDEFGHI", userPoolClientId: "1h57kf5cpq17m0eml12example", awsCognitoRegion: "eu-west-1" };

type Profile = { name: string; env: Record<string, string>; layer: boolean };

const profiles: Profile[] = [
  {
    // A — the lean multi-tenant default: no custom domain, no layer, no alarms relay.
    name: "a-minimal",
    layer: false,
    env: { hereyaProjectEnv: JSON.stringify(BASE_PROJECT_ENV) },
  },
  {
    // B — legacy single-org shape: custom domain + Cognito frontend distribution,
    // runtime layer present, alarm relay + agent inbox wired, organizationId set.
    name: "b-customdomain-cognito-layer",
    layer: true,
    env: {
      organizationId: "88120129-295f-476c-b1e1-382ecbc7381a",
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/1111-2222",
      telegramBotTokenParam: "/dilaya/telegram/token",
      telegramChatId: "123456789",
      alarmInboxOrg: "88120129-295f-476c-b1e1-382ecbc7381a",
      alarmInboxApp: "dilayadev",
      memorySize: "512",
      timeout: "60",
      hereyaProjectEnv: JSON.stringify({ ...BASE_PROJECT_ENV, ...COGNITO_ENV }),
    },
  },
  {
    // C — production shape: multi-tenant (no organizationId), app-content domain,
    // origin lock + rotation window, domain purchase, extra forwarded headers.
    name: "c-appcontent-full",
    layer: true,
    env: {
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/1111-2222",
      appContentDomain: "example-apps.eu",
      appContentZoneId: "ZAPPCONTENT123",
      appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/3333-4444",
      appContentOriginSecret: "0123456789abcdef0123456789abcdef",
      appContentOriginSecretPrevious: "fedcba9876543210fedcba9876543210",
      domainPurchase: "true",
      additionalForwardedHeaders: "X-Dilaya-Agent-Token, X-Custom-Thing",
      frontendRateLimit: "500",
      frontendRateBlock: "false",
      telegramBotTokenParam: "/dilaya/telegram/token",
      telegramChatId: "123456789",
      alarmInboxOrg: "88120129-295f-476c-b1e1-382ecbc7381a",
      alarmInboxApp: "dilayadev",
      hereyaProjectEnv: JSON.stringify({ ...BASE_PROJECT_ENV, ...COGNITO_ENV }),
    },
  },
  {
    // D — the same feature ON but every optional sub-feature OFF: app-content
    // without origin secret, without domain purchase, without Cognito.
    name: "d-appcontent-featureoff",
    layer: false,
    env: {
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/1111-2222",
      appContentDomain: "example-apps.eu",
      appContentZoneId: "ZAPPCONTENT123",
      appContentCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/3333-4444",
      hereyaProjectEnv: JSON.stringify(BASE_PROJECT_ENV),
    },
  },
  {
    // E — a SECONDARY regional pod (t_rca_p0_infra): owns only its origin host,
    // no once-per-account edge resource, Cognito env present but ignored.
    name: "e-secondary-pod",
    layer: true,
    env: {
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/5555-6666",
      originDomain: "ca.app.example.eu",
      skipGlobalResources: "true",
      hereyaProjectEnv: JSON.stringify({ ...BASE_PROJECT_ENV, ...COGNITO_ENV }),
    },
  },
  {
    // F — the primary pod behind its REGION ROUTER (t_rca_p1_router): owns its
    // origin host, creates the front-door distribution + function + KVS, wires
    // the Lambda@Edge version, honours the forwarded viewer host.
    name: "f-region-router",
    layer: true,
    env: {
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/1111-2222",
      originDomain: "app-eu.example.eu",
      regionRouter: "true",
      regionRouterOrigins: "eu-west-1:app-eu.example.eu,ca-central-1:app-ca.example.eu",
      regionRouterCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/7777-8888",
      regionRouterEdgeVersionArn: "arn:aws:lambda:us-east-1:123456789012:function:rr-edge:1",
      regionRouterOriginSecret: "0123456789abcdef0123456789abcdef-router",
      hereyaProjectEnv: JSON.stringify(BASE_PROJECT_ENV),
    },
  },
  {
    // G — the secondary pod wired to the EU registry's global partitions and to the
    // eu-west-1 SSM parameter its executor left unresolved (lib/stack/secondary-pod.ts).
    name: "g-secondary-pod-global",
    layer: true,
    env: {
      customDomain: "app.example.eu",
      customDomainZone: "example.eu",
      wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/5555-6666",
      originDomain: "ca.app.example.eu",
      skipGlobalResources: "true",
      globalRegistryTableArn: "arn:aws:dynamodb:eu-west-1:123456789012:table/eu-registry",
      hereyaProjectEnv: JSON.stringify({
        ...BASE_PROJECT_ENV,
        // The harness synthesizes in eu-west-1, so the "other" region is us-east-2.
        GITHUB_APP_PRIVATE_KEY: "aws:arn:aws:ssm:us-east-2:123456789012:parameter/hereya/gh-key",
      }),
    },
  },
  {
    // H — the secondary pod CONSUMING the primary's app-content edge (lib/stack/app-content/consumer.ts).
    name: "h-secondary-pod-appcontent-consumer",
    layer: true,
    env: {
      customDomain: "app.example.eu", customDomainZone: "example.eu", originDomain: "ca.app.example.eu",
      wildcardCertificateArn: "arn:aws:acm:ca-central-1:123456789012:certificate/5555-6666",
      skipGlobalResources: "true", globalRegistryTableArn: "arn:aws:dynamodb:eu-west-1:123456789012:table/eu-registry",
      appContentDomain: "example-apps.eu", appContentZoneId: "ZAPPCONTENT123", appContentOriginSecret: "0123456789abcdef0123456789abcdef",
      appContentHostKvsArn: "arn:aws:cloudfront::123456789012:key-value-store/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
      hereyaProjectEnv: JSON.stringify({ ...BASE_PROJECT_ENV, ...COGNITO_ENV }),
    },
  },
];
// I — H plus the BYOD control plane of its orgs' custom domains (lib/stack/app-content/byod-edge.ts).
profiles.push({ ...profiles[7]!, name: "i-secondary-pod-appcontent-consumer-byod", env: { ...profiles[7]!.env, appContentByodEdge:
  "eu-apphost-router:aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb:cccccccc-4444-4555-8666-dddddddddddd:E1ABCDEFGHIJKL:eu-static.s3.eu-west-1.amazonaws.com:eu-edge-logs.s3.eu-west-1.amazonaws.com:app-eu.example.eu" } });

const KEYS = [
  "hereyaProjectRootDir", "oauthServerUrl", "hereyaProjectEnv", "organizationId", "memorySize", "timeout", "handler",
  "customDomain", "customDomainZone", "wildcardCertificateArn", "appContentDomain", "appContentZoneId",
  "appContentCertArn", "appContentOriginSecret", "appContentOriginSecretPrevious", "frontendRateLimit",
  "frontendRateBlock", "domainPurchase", "expectedAudience", "additionalForwardedHeaders", "telegramBotTokenParam",
  "telegramChatId", "alarmInboxOrg", "alarmInboxApp", "originDomain", "skipGlobalResources", "regionRouter",
  "regionRouterOrigins", "regionRouterCertArn", "regionRouterEdgeVersionArn", "regionRouterOriginSecret",
  "filesDomain", "filesZoneId", "filesCertArn", "mcpDomain", "globalRegistryTableArn",
  "appContentHostKvsArn", "appContentRegionOrigins", "appContentByodEdge"];

for (const p of profiles) {
  for (const k of KEYS) delete process.env[k];
  process.env.hereyaProjectRootDir = makeRoot(p.layer);
  process.env.oauthServerUrl = "https://example.eu/oauth/connect";
  for (const [k, v] of Object.entries(p.env)) process.env[k] = v;

  const app = new cdk.App();
  const stack = new DilayaConnectorLambdaStack(app, "GoldenStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  const json = Template.fromStack(stack).toJSON();
  fs.writeFileSync(path.join(outDir, `${p.name}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(`${p.name}: ${Object.keys(json.Resources ?? {}).length} resources`);
}
