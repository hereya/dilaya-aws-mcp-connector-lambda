import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

// The stage names its routes in STRINGS, so CloudFormation cannot see that it
// depends on them — and orders the update however it likes.
//
// WHAT THIS COST, ON 2026-09-07. The stage carries per-route settings (detailed
// metrics + the last-resort throttle), derived by walking the construct tree,
// so adding a route adds a key. Deploying 0.1.216 to app.dilaya.eu — the first
// time a route had been added since those settings existed — CloudFormation
// updated the STAGE before creating the ROUTES:
//
//   Unable to find Route by key POST /org-domains/auto-renew
//   within the provided RouteSettings (Service: ApiGatewayV2, 404)
//
// and then the ROLLBACK failed on the mirror image of the same quirk (removing
// the settings of a route that does not exist is a 404 too), leaving the
// production stack in UPDATE_ROLLBACK_FAILED: traffic unaffected, every future
// deploy blocked until a human ran continue-update-rollback by hand.
//
// WHY NOTHING SAW IT COMING. `cdk synth` is happy — the template is valid.
// `tsc` is happy. Every existing test is happy, because they assert that the
// routes and the settings EXIST, which they do. The fault is entirely in the
// ORDER of two resources, which lives in exactly one place: `DependsOn` in the
// synthesized template. So that is what this file reads.
//
// It is not a test about /org-domains. It is a test about every route this
// stack will ever add — the next one is added by someone who has never heard
// of this incident.
describe("the stage is written AFTER the routes it names", () => {
  let tmpRoot: string;
  const saved = { ...process.env };

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-synth-ordering-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "dist", "handler.js"),
      "exports.handler=async()=>({});"
    );
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    process.env.domainPurchase = "true";
    process.env.customDomain = "app.dilaya.eu";
    process.env.customDomainZone = "dilaya.eu";
    process.env.wildcardCertificateArn =
      "arn:aws:acm:eu-west-1:123456789012:certificate/mcp-cert";
    process.env.appContentDomain = "dilaya-apps.eu";
    process.env.appContentZoneId = "ZAPPCONTENT";
    process.env.appContentCertArn =
      "arn:aws:acm:us-east-1:123456789012:certificate/app-content-cert";
    delete process.env.organizationId;
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function template(): Template {
    const app = new cdk.App({
      context: {
        "hosted-zone:account=123456789012:domainName=dilaya.eu:region=eu-west-1": {
          Id: "/hostedzone/ZCUSTOMDOMAIN",
          Name: "dilaya.eu.",
        },
      },
    });
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    return Template.fromStack(stack);
  }

  it("every route named in RouteSettings is a DependsOn of the stage", () => {
    const t = template();
    const stages = t.findResources("AWS::ApiGatewayV2::Stage");
    const stageIds = Object.keys(stages);
    expect(stageIds).toHaveLength(1);
    const stage = stages[stageIds[0]!]!;

    const settings = (stage.Properties?.RouteSettings ?? {}) as Record<string, unknown>;
    const settingKeys = Object.keys(settings);
    // A guard that cannot pass vacuously: if the per-route settings were ever
    // removed, this test must be re-thought, not silently satisfied.
    expect(settingKeys.length).toBeGreaterThan(0);

    const dependsOn = new Set(
      Array.isArray(stage.DependsOn) ? stage.DependsOn : stage.DependsOn ? [stage.DependsOn] : []
    );

    // routeKey → logical id, from the template itself.
    const routes = t.findResources("AWS::ApiGatewayV2::Route");
    const idByKey = new Map<string, string>();
    for (const [logicalId, res] of Object.entries(routes)) {
      const key = (res.Properties as { RouteKey?: string } | undefined)?.RouteKey;
      if (typeof key === "string") idByKey.set(key, logicalId);
    }

    const missing: string[] = [];
    for (const key of settingKeys) {
      const logicalId = idByKey.get(key);
      // A settings key naming no route at all is the very 404 this guards.
      expect(logicalId).toBeDefined();
      if (logicalId && !dependsOn.has(logicalId)) missing.push(`${key} (${logicalId})`);
    }
    expect(missing).toEqual([]);
  });

  it("covers the routes added LAST, not just the ones that existed early", () => {
    // The reason this is an Aspect and not a loop at the point where the
    // settings are declared: routes are created all over the constructor, and a
    // dependency wired inline would silently cover only those built so far —
    // i.e. never the newly added route, which is the only one that can break a
    // deploy.
    const t = template();
    const stage = Object.values(t.findResources("AWS::ApiGatewayV2::Stage"))[0]!;
    const dependsOn = new Set((stage.DependsOn as string[]) ?? []);
    const routeIds = Object.keys(t.findResources("AWS::ApiGatewayV2::Route"));
    expect(routeIds.length).toBeGreaterThan(5);
    for (const id of routeIds) expect(dependsOn.has(id)).toBe(true);
  });
});
