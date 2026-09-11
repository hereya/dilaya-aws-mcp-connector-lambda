import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";

/**
 * One secret:// entry of `hereyaProjectEnv`, resolved into a real Secret.
 */
export interface SecretEnvEntry {
  key: string;
  secret: secrets.Secret;
  secretName: string;
}

/**
 * Everything the stack's build steps hand to each other.
 *
 * This file replaces what used to be ~3 100 lines of local variables in one
 * constructor: each step reads what it needs off this object and writes back
 * what later steps need. The steps are called in a fixed order (see
 * `dilaya-aws-mcp-connector-lambda-stack.ts`), and that order is the contract —
 * a field is only readable once the step that sets it has run. Fields typed
 * `| undefined` are the ones the stack itself BRANCHES on (an absent custom
 * domain, no runtime layer, …); every other field is populated unconditionally
 * before any reader runs.
 *
 * Order matters for more than availability: IAM statements are appended to the
 * connector role in call order, so moving a step moves the synthesized policy.
 */
export interface StackContext {
  // --- config (from the synth environment) ---
  hereyaProjectRootDir: string;
  oauthServerUrl: string;
  organizationId: string;
  memorySize: number;
  timeout: number;
  handlerName: string;
  customDomain: string | undefined;
  customDomainZone: string | undefined;
  wildcardCertificateArn: string | undefined;
  appContentDomain: string | undefined;
  appContentZoneId: string | undefined;
  appContentCertArn: string | undefined;
  appContentOriginSecret: string | undefined;
  appContentOriginSecretPrevious: string | undefined;
  frontendRateLimit: string;
  frontendRateBlock: string;
  domainPurchase: boolean;
  expectedAudience: string;
  frontendForwardHeaders: string[];

  // --- hereyaProjectEnv, split three ways ---
  policyEnv: Record<string, string>;
  nonPolicyEnv: Record<string, string>;
  plainEnv: Record<string, string>;
  secretEnvEntries: SecretEnvEntry[];
  capSecretEntry: SecretEnvEntry | undefined;
  capSecretName: string;
  cognitoUserPoolId: string | undefined;
  cognitoClientId: string | undefined;
  cognitoRegion: string;
  appLambdaNamePrefix: string;

  // --- the connector Lambda and its alarms ---
  fn: lambda.Function;
  capabilityRejectedAlarm: cloudwatch.Alarm;
  alarmInboxOrg: string;
  alarmInboxApp: string;
  /** Wires an alarm to the Telegram relay in both directions; no-op when unconfigured. */
  alertOn: (alarm: cloudwatch.Alarm) => void;
  /** Every function that gets an Errors/Throttles alarm at the end of the stack. */
  monitoredFunctions: { label: string; fn: lambda.Function }[];

  // --- per-app Lambda plumbing ---
  appLambdaBoundary: iam.ManagedPolicy;
  appRolePath: string;
  appLambdaArnPattern: string;
  runtimeLayer: lambda.LayerVersion | undefined;
  triggerArns: string[];
  appStateTable: dynamodb.Table;

  // --- HTTP API ---
  httpAuthorizer: authorizers.HttpLambdaAuthorizer;
  httpApi: apigwv2.HttpApi;
  accessLogGroup: logs.LogGroup;
  cfnDefaultStage: apigwv2.CfnStage;
  httpApi5xxAllFilter: logs.MetricFilter;
  httpApi5xxTenantAppFilter: logs.MetricFilter;
  prmLambda: lambda.Function;
  lambdaIntegration: integrations.HttpLambdaIntegration;
  frontendAuthorizerId: string | undefined;
  authIntegrationId: string | undefined;
  frontendAuthorizerRef: lambda.Function | undefined;

  // --- custom domain ---
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  domainName: apigwv2.DomainName;

  // --- app-content domain (vanity hosts) ---
  appContentCertificate: acm.ICertificate;
  appContentZone: route53.IHostedZone;
  appHostKvs: cloudfront.KeyValueStore;
  staticAssetsBucket: s3.Bucket;
  staticAssetsOac: cloudfront.S3OriginAccessControl;
  staticAssetsOrigin: cloudfront.IOrigin;
  appHostRouterFn: cloudfront.Function;
  appContentCachePolicy: cloudfront.CachePolicy;
  appContentOriginPolicy: cloudfront.OriginRequestPolicy;
  appContentDistribution: cloudfront.Distribution;
  edgeLogBucket: s3.Bucket;

  // --- legacy per-org frontend distribution ---
  cfFunction: cloudfront.Function;
  cloudfrontCertificate: acm.DnsValidatedCertificate;
  distribution: cloudfront.Distribution;
  seedViewerCertArn: cr.AwsCustomResource;
  viewerCertSsmParamName: string;
  viewerCertSsmParamArn: string;
}

/** A context with nothing filled in yet; `readStackConfig` is the first writer. */
export function emptyContext(_stack: cdk.Stack): StackContext {
  return { monitoredFunctions: [] } as unknown as StackContext;
}
