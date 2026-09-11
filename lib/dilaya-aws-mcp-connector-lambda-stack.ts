import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { emptyContext } from "./stack/context";
import { readStackConfig } from "./stack/config";
import { readProjectEnv } from "./stack/project-env";
import { createHandlerFunction } from "./stack/handler-function";
import { createCapabilityAlarm } from "./stack/capability-alarm";
import { createAlarmRelay } from "./stack/alarm-relay";
import { attachDependencyPolicies } from "./stack/handler-policies";
import { createAppLambdaBoundary } from "./stack/app-lambda-boundary";
import { createRuntimeLayer } from "./stack/runtime-layer";
import { createAppAuthTriggers } from "./stack/app-auth-triggers";
import { createMcpAuthorizer } from "./stack/mcp-authorizer";
import { createHttpApi } from "./stack/http-api";
import { configureStageSettings } from "./stack/stage-settings";
import { createAccessLogFilters } from "./stack/access-log-filters";
import { createPrmLambda } from "./stack/prm";
import { createRoutes } from "./stack/routes";
import { createBillingRoutes } from "./stack/routes-billing";
import { createFrontendAuthorizer } from "./stack/frontend-authorizer";
import { createAuthLambda } from "./stack/auth-lambda";
import { createAppCrons } from "./stack/app-crons";
import { grantAppLambdaManagement } from "./stack/app-lambda-iam";
import { grantConnectorSsm } from "./stack/connector-ssm";
import { setConnectorEnv } from "./stack/connector-env";
import { createAppStateTable } from "./stack/app-state-table";
import { grantCognitoProvisioning } from "./stack/cognito-provisioning-iam";
import { createCustomDomainDns } from "./stack/custom-domain-dns";
import { resolveAppContentDomain } from "./stack/app-content/domain";
import { createStaticAssets } from "./stack/app-content/static-assets";
import { createAppHostRouter } from "./stack/app-content/router-function";
import { createAppContentPolicies } from "./stack/app-content/policies";
import { createAppContentDistribution } from "./stack/app-content/distribution";
import { wireConnectorToAppContent } from "./stack/app-content/connector-wiring";
import { grantByodDistributions } from "./stack/app-content/byod-iam";
import { grantDomainPurchase } from "./stack/app-content/domain-purchase-iam";
import { createOriginRestamp } from "./stack/app-content/origin-restamp";
import { appContentOutputs } from "./stack/app-content/outputs";
import { createSubdomainRewrite } from "./stack/frontend-distribution/edge-function";
import { createFrontendDistribution } from "./stack/frontend-distribution/distribution";
import { seedViewerCert } from "./stack/frontend-distribution/viewer-cert-seed";
import { grantCustomDomainManagement } from "./stack/frontend-distribution/iam";
import { createCoreAlarms } from "./stack/alarms/core";
import { createTrafficAlarms } from "./stack/alarms/traffic";
import { createRateGuardAlarm } from "./stack/alarms/rate-guard";
import { createRequestCapAlarm } from "./stack/alarms/request-cap";
import { createPlatform5xxAlarm } from "./stack/alarms/platform-5xx";
import { createAppStateAlarms } from "./stack/alarms/dynamodb";

/**
 * The connector's deploy stack, as an ordered list of build steps.
 *
 * Each step lives in `lib/stack/` and takes (stack, ctx): it reads what earlier
 * steps produced off the context and writes back what later ones need. Every
 * construct is still created with THIS stack as its scope, so logical ids — and
 * therefore the deployed resources — are exactly what they were when this was
 * one 3 100-line constructor.
 *
 * THE ORDER BELOW IS LOAD-BEARING. `addToRolePolicy` appends to the connector
 * role in call order, so re-ordering two steps re-orders the synthesized policy
 * document; and a step reads context fields that only an earlier step sets.
 * `scripts/synth-golden.ts` is what proves a change here kept the template
 * intact — neither `tsc` nor a green `cdk synth` can see either kind of drift.
 */
export class DilayaConnectorLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = emptyContext(this);

    readStackConfig(this, ctx);
    readProjectEnv(this, ctx);

    createHandlerFunction(this, ctx);
    createCapabilityAlarm(this, ctx);
    createAlarmRelay(this, ctx);

    // Every function that gets an Errors/Throttles alarm at the end of the
    // stack. Collected as they are built because several are created inside
    // feature-conditional blocks and would otherwise be out of scope there.
    ctx.monitoredFunctions.push({ label: "Handler", fn: ctx.fn });

    attachDependencyPolicies(this, ctx);

    createAppLambdaBoundary(this, ctx);
    createRuntimeLayer(this, ctx);
    createAppAuthTriggers(this, ctx);

    createMcpAuthorizer(this, ctx);
    createHttpApi(this, ctx);
    configureStageSettings(this, ctx);
    createAccessLogFilters(this, ctx);
    createPrmLambda(this, ctx);
    createRoutes(this, ctx);
    createBillingRoutes(this, ctx);

    createFrontendAuthorizer(this, ctx);
    createAuthLambda(this, ctx);

    // -----------------------------------------------------------------------
    // Org Lambda: per-app Lambda management permissions
    // -----------------------------------------------------------------------

    ctx.appLambdaArnPattern = `arn:aws:lambda:${this.region}:${this.account}:function:${ctx.appLambdaNamePrefix}*`;

    createAppCrons(this, ctx);
    grantAppLambdaManagement(this, ctx);
    grantConnectorSsm(this, ctx);
    setConnectorEnv(this, ctx);
    createAppStateTable(this, ctx);
    grantCognitoProvisioning(this, ctx);

    // -----------------------------------------------------------------------
    // Custom domain + DNS
    // -----------------------------------------------------------------------

    const { customDomain, customDomainZone } = ctx;
    if (customDomain && customDomainZone) {
      if (!ctx.wildcardCertificateArn) {
        throw new Error(
          "wildcardCertificateArn is required when customDomain is set"
        );
      }

      createCustomDomainDns(this, ctx);

      if (ctx.appContentDomain) {
        resolveAppContentDomain(this, ctx);
        createStaticAssets(this, ctx);
        createAppHostRouter(this, ctx);
        createAppContentPolicies(this, ctx);
        createAppContentDistribution(this, ctx);
        wireConnectorToAppContent(this, ctx);
        grantByodDistributions(this, ctx);
        grantDomainPurchase(this, ctx);
        createOriginRestamp(this, ctx);
        appContentOutputs(this, ctx);
      }

      // -------------------------------------------------------------------
      // CloudFront distribution for frontend (*.{customDomain})
      // -------------------------------------------------------------------

      if (ctx.cognitoUserPoolId && ctx.cognitoClientId) {
        createSubdomainRewrite(this, ctx);
        createFrontendDistribution(this, ctx);
        seedViewerCert(this, ctx);
        grantCustomDomainManagement(this, ctx);
      }

      new cdk.CfnOutput(this, "ServiceUrl", {
        value: `https://${customDomain}`,
      });
    } else {
      new cdk.CfnOutput(this, "ServiceUrl", {
        value: ctx.httpApi.apiEndpoint,
      });
    }

    createCoreAlarms(this, ctx);
    createTrafficAlarms(this, ctx);
    createRateGuardAlarm(this, ctx);
    createRequestCapAlarm(this, ctx);
    createPlatform5xxAlarm(this, ctx);
    createAppStateAlarms(this, ctx);
  }
}
