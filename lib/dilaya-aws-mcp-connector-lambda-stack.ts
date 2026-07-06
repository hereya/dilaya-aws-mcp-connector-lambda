import * as cdk from "aws-cdk-lib/core";
import { SecretValue } from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";

export class DilayaConnectorLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hereyaProjectRootDir = process.env["hereyaProjectRootDir"];
    if (!hereyaProjectRootDir) {
      throw new Error("hereyaProjectRootDir environment variable is required");
    }

    const oauthServerUrl = process.env["oauthServerUrl"];
    if (!oauthServerUrl) {
      throw new Error("oauthServerUrl environment variable is required");
    }

    // Multi-tenant connector: NO single bound org. organizationId is optional
    // and empty here — the authorizer validates the org SET (org_ids) from the
    // single-URL connect AS instead of binding one org at deploy time. The
    // per-org SSM/tag scopings inherited from the source package that reference
    // it become inert (they back frontend/secrets/agent features the connector
    // defers). If ever set, the authorizer falls back to legacy single-org mode.
    const organizationId = process.env["organizationId"] ?? "";

    const memorySize = process.env["memorySize"]
      ? parseInt(process.env["memorySize"])
      : 256;
    const timeout = process.env["timeout"]
      ? parseInt(process.env["timeout"])
      : 30;
    const handlerName = process.env["handler"] ?? "handler.handler";
    const customDomain = process.env["customDomain"];
    const customDomainZone =
      process.env["customDomainZone"] ?? extractDomainZone(customDomain);
    const wildcardCertificateArn = process.env["wildcardCertificateArn"];

    // -----------------------------------------------------------------------
    // App-content domain (host-routing, FLAT scheme). OPTIONAL and additive:
    // absent → this whole feature is inert and existing behaviour is
    // byte-identical. When set, we stand up a dedicated CloudFront distribution
    // that serves per-app frontends at the flat vanity host
    //   <app>--<orgslug>.<appContentDomain>   (e.g. smartcal--novopattern.dilaya-apps.eu)
    // IN ADDITION to the existing path URL https://<customDomain>/o/<org>/<app>/site/.
    //   - appContentDomain   e.g. `dilaya-apps.eu`
    //   - appContentZoneId   the Route53 hosted-zone id for appContentDomain
    //   - appContentCertArn  the us-east-1 ARN of the pre-created `*.<appContentDomain>`
    //                        cert (passed in — NOT created by CDK)
    // -----------------------------------------------------------------------
    const appContentDomain = process.env["appContentDomain"];
    const appContentZoneId = process.env["appContentZoneId"];
    const appContentCertArn = process.env["appContentCertArn"];

    // RFC 8707 audience binding: the connector's own /mcp resource URL. Derived
    // from customDomain so it can't be dropped (Hereya only forwards hereyavars
    // backed by a declared app parameter, and a free-form `expectedAudience`
    // var is silently filtered). An explicit override still wins. When set, the
    // authorizer requires the token's aud to match — so a token minted for a
    // different resource can't be replayed here.
    const expectedAudience =
      process.env["expectedAudience"] ||
      (customDomain ? `https://${customDomain}/mcp` : "");
    // Extra request headers the frontend CloudFront distribution should forward to
    // origin (comma-separated). CloudFront strips any header not whitelisted, so
    // custom auth/webhook headers must be listed here. NOTE: `Authorization` CANNOT
    // be added to an OriginRequestPolicy (AWS only allows it via a cache policy) —
    // use a custom header name instead (e.g. X-Dilaya-Agent-Token for the agent poll).
    const additionalForwardedHeaders = (process.env["additionalForwardedHeaders"] ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const frontendForwardHeaders = [
      "Content-Type",
      "Accept-Language",
      "x-forwarded-host",
      "X-Telegram-Bot-Api-Secret-Token",
      // The app-content edge (CloudFront Function) tags the viewer's vanity host
      // in `x-dilaya-app-host`; the origin (auth Lambda / per-app frontend) reads
      // it to scope cookies + emit app-relative redirects. Only added when the
      // host-routing feature is enabled so the feature-off output is unchanged.
      ...(appContentDomain ? ["x-dilaya-app-host"] : []),
      ...additionalForwardedHeaders,
    ].filter((h, i, a) => a.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);

    // Parse hereyaProjectEnv
    const env: Record<string, string> = JSON.parse(
      process.env["hereyaProjectEnv"] ?? "{}"
    );

    // Separate IAM policy env vars
    const policyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => key.startsWith("IAM_POLICY_") || key.startsWith("iamPolicy")
      )
    );

    const nonPolicyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith("IAM_POLICY_") && !key.startsWith("iamPolicy")
      )
    );

    // Separate secret env vars (secret:// prefix)
    const secretEnvEntries = Object.entries(nonPolicyEnv)
      .filter(([, value]) => (value as string).startsWith("secret://"))
      .map(([key, value]) => {
        const plainValue = (value as string).split("secret://")[1];
        const secretName = `/${this.stackName}/${key}`;
        const secret = new secrets.Secret(this, key, {
          secretName,
          secretStringValue: SecretValue.unsafePlainText(plainValue),
        });
        return { key, secret, secretName };
      });

    // The capability signing secret arrives as a secret:// value (hereya resolves
    // the VM's capabilitySecretArn output to its value), so it's in secretEnvEntries,
    // NOT plainEnv. The per-app auth Lambdas (frontend-authorizer + auth-lambda)
    // MINT capability tokens, so they must read it — pass its secret name + grantRead.
    const capSecretEntry = secretEnvEntries.find((e) => e.key === "capabilitySecretArn");
    const capSecretName = capSecretEntry?.secretName ?? "";

    const plainEnv: Record<string, string> = Object.fromEntries(
      Object.entries(nonPolicyEnv).filter(
        ([, value]) => !(value as string).startsWith("secret://")
      )
    );


    // Cognito config (from aws/cognito package outputs via hereyaProjectEnv)
    const cognitoUserPoolId = plainEnv["userPoolId"] ?? nonPolicyEnv["userPoolId"];
    const cognitoClientId = plainEnv["userPoolClientId"] ?? nonPolicyEnv["userPoolClientId"];
    const cognitoRegion = plainEnv["awsCognitoRegion"] ?? nonPolicyEnv["awsCognitoRegion"] ?? process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";

    // -----------------------------------------------------------------------
    // Lambda naming prefix for per-app Lambdas (derived from customDomain)
    // -----------------------------------------------------------------------

    const orgPrefix = customDomain
      ? customDomain.split(".")[0]
      : this.stackName.substring(0, 20);
    const appLambdaNamePrefix = `${orgPrefix}-app-`;

    // -----------------------------------------------------------------------
    // Lambda 1: App Handler (Org Lambda — MCP only)
    // -----------------------------------------------------------------------

    // Pass deploy-time config vars to the handler (not in hereyaProjectEnv)
    if (customDomain) {
      plainEnv["customDomain"] = customDomain;
    }

    const fn = new lambda.Function(this, "Handler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: handlerName,
      code: lambda.Code.fromAsset(path.join(hereyaProjectRootDir, "dist")),
      memorySize,
      timeout: cdk.Duration.seconds(timeout),
      environment: plainEnv,
    });

    // Attach secret references (secret name, not value) and grant read access
    const secretKeys: string[] = [];
    for (const { key, secret, secretName } of secretEnvEntries) {
      fn.addEnvironment(key, secretName);
      secret.grantRead(fn);
      secretKeys.push(key);
    }
    if (secretKeys.length > 0) {
      fn.addEnvironment("SECRET_KEYS", secretKeys.join(","));
    }

    // Attach IAM policies from dependency packages
    for (const [, value] of Object.entries(policyEnv)) {
      const policy = JSON.parse(value as string);
      for (const statement of policy.Statement) {
        fn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
      }
    }

    // -----------------------------------------------------------------------
    // Per-app Lambda roles — created at RUNTIME, one per (org,app), by the
    // connector (src/app-lambda.ts createAppRole). This replaces the old single
    // shared role, which physically couldn't bake in a specific orgId, so its
    // S3 grant had to be storage-prefix-wide (a cross-tenant file gap). Now each
    // per-app Lambda gets its OWN role whose inline policy is scoped to
    // <orgId>/<app>/*. Two guardrails keep runtime role-creation safe:
    //   1. the connector may only CreateRole under `appRolePath`, and only if it
    //      attaches the PERMISSIONS BOUNDARY below (see the fn IAM grants);
    //   2. the boundary is the hard ceiling for ANY per-app role — even a bug in
    //      the inline policy can't exceed "logs + VM data routes + files-bucket
    //      S3": no IAM, no VM /admin/*, no other buckets, no Cognito, no secrets.
    // -----------------------------------------------------------------------

    const appRolePath = "/dilaya-app/";
    const vmApiId = nonPolicyEnv["dataApiUrl"]
      ? new URL(nonPolicyEnv["dataApiUrl"]).host.split(".")[0]
      : undefined;
    const appBucket = nonPolicyEnv["bucketName"];
    const appPrefix = nonPolicyEnv["s3Prefix"];

    const boundaryStatements: iam.PolicyStatement[] = [
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*`],
      }),
    ];
    if (vmApiId) {
      // Data routes only — NEVER /admin/* (delete-app, sync are connector-only).
      boundaryStatements.push(
        new iam.PolicyStatement({
          actions: ["execute-api:Invoke"],
          resources: ["POST/query", "POST/batch-execute", "POST/tx/begin", "POST/tx/commit", "POST/tx/rollback", "GET/stats"].map(
            (r) => `arn:aws:execute-api:${this.region}:${this.account}:${vmApiId}/*/${r}`
          ),
        })
      );
    }
    if (appBucket) {
      // Ceiling = the whole files bucket/prefix; each per-app role's inline
      // policy narrows this to its own <orgId>/<app>/*.
      boundaryStatements.push(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`arn:aws:s3:::${appBucket}/${appPrefix ? appPrefix + "/" : ""}*`],
        }),
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [`arn:aws:s3:::${appBucket}`],
        })
      );
    }
    // Mail (now) + integration secrets (next milestone): a per-app frontend
    // handler can read its OWN app's Postmark server token / integration secrets
    // from SSM SecureString. CEILING = any org/app's `/mail/*` + `/secrets/*`
    // params; each per-app role's inline policy (src/app-lambda.ts
    // appRolePolicyDocument) narrows this to /dilaya/<orgId>/apps/<app>/{mail,secrets}/*.
    // No other SSM paths (never the agent/telegram/viewer-cert params).
    boundaryStatements.push(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/dilaya/*/apps/*/mail/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/dilaya/*/apps/*/secrets/*`,
        ],
      }),
      // Decrypt the SecureString value — usable ONLY through SSM (kms:ViaService),
      // same pattern as the connector fn's own ssmKmsDecrypt grant.
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` },
        },
      })
    );
    const appLambdaBoundary = new iam.ManagedPolicy(this, "AppLambdaBoundary", {
      description: "Permissions ceiling for per-app frontend Lambda roles (logs + VM data routes + files bucket + own-app mail/secrets SSM).",
      statements: boundaryStatements,
    });

    // -----------------------------------------------------------------------
    // Lambda Layer for per-app runtime utilities
    // -----------------------------------------------------------------------

    // The per-app frontend Lambda runtime layer is only produced by apps that
    // build it (`build:layer`). The lean multi-tenant connector defers web
    // frontends and ships no layer, so create it only when the asset exists.
    const layerDir = path.join(hereyaProjectRootDir, "dist", "layer");
    const runtimeLayer = fs.existsSync(layerDir)
      ? new lambda.LayerVersion(this, "AppRuntimeLayer", {
          code: lambda.Code.fromAsset(layerDir),
          compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
          description: "Hereya runtime (db, storage) for per-app Lambdas",
        })
      : undefined;

    // -----------------------------------------------------------------------
    // Per-app auth: shared multi-tenant Cognito triggers + OTP table.
    //
    // `enable-auth` provisions a dedicated Cognito user pool per app. All
    // pools across the org are wired to the same 4 challenge trigger Lambdas
    // declared here — the triggers are pool-agnostic (they read
    // event.userPoolId at runtime). The OTP table is keyed by
    // (pool_id, email) so concurrent logins across pools can't collide.
    // -----------------------------------------------------------------------

    const otpTable = new dynamodb.Table(this, "AppAuthOtpTable", {
      partitionKey: {
        name: "pool_id",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const triggerEnv = { OTP_TABLE_NAME: otpTable.tableName };
    const makeTrigger = (id: string, dir: string) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "cognito-triggers", dir)
        ),
        memorySize: 128,
        timeout: cdk.Duration.seconds(10),
        environment: triggerEnv,
      });

    const preSignUpFn = makeTrigger("PreSignUpTrigger", "pre-sign-up");
    const defineChallengeFn = makeTrigger(
      "DefineAuthChallengeTrigger",
      "define-auth-challenge"
    );
    const createChallengeFn = makeTrigger(
      "CreateAuthChallengeTrigger",
      "create-auth-challenge"
    );
    const verifyChallengeFn = makeTrigger(
      "VerifyAuthChallengeTrigger",
      "verify-auth-challenge"
    );

    otpTable.grantReadWriteData(createChallengeFn);
    otpTable.grantReadWriteData(verifyChallengeFn);

    // Verify trigger also updates the Cognito user attribute `email_verified`.
    // Scoping to resource="*" because per-app pools are created at runtime by
    // the org Lambda — we can't pin a single ARN at stack deploy time.
    verifyChallengeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminUpdateUserAttributes"],
        resources: ["*"],
      })
    );

    const triggerArns = [
      preSignUpFn.functionArn,
      defineChallengeFn.functionArn,
      createChallengeFn.functionArn,
      verifyChallengeFn.functionArn,
    ];

    // -----------------------------------------------------------------------
    // MCP OAuth Authorizer Lambda
    // -----------------------------------------------------------------------

    const authorizerFn = new lambda.Function(this, "AuthorizerHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "authorizer")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OAUTH_SERVER_URL: oauthServerUrl,
        BOUND_ORG_ID: organizationId, // empty ⇒ multi-tenant org_ids mode
        EXPECTED_AUDIENCE: expectedAudience,
      },
    });

    const httpAuthorizer = new authorizers.HttpLambdaAuthorizer(
      "HereyaAuthorizer",
      authorizerFn,
      {
        responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
        resultsCacheTtl: cdk.Duration.minutes(5),
      }
    );

    // -----------------------------------------------------------------------
    // HTTP API
    // -----------------------------------------------------------------------

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: this.stackName,
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "LambdaIntegration",
      fn
    );

    // Compute service URL for PRM (custom domain or API endpoint)
    const serviceUrl = customDomain
      ? `https://${customDomain}`
      : httpApi.apiEndpoint;

    // -----------------------------------------------------------------------
    // Protected Resource Metadata (RFC 9728)
    // -----------------------------------------------------------------------

    const prmLambda = new lambda.Function(this, "PrmHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            resource: process.env.SERVICE_URL + "/mcp",
            // Multi-tenant: point at the single-URL connect AS issuer
            // (OAUTH_SERVER_URL = <base>/oauth/connect). Legacy per-org mode
            // (ORGANIZATION_ID set) keeps the old <base>/oauth/<orgId> shape.
            authorization_servers: [
              process.env.ORGANIZATION_ID
                ? process.env.OAUTH_SERVER_URL + "/oauth/" + process.env.ORGANIZATION_ID
                : process.env.OAUTH_SERVER_URL,
            ],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp:access"],
          }),
        });
      `),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: {
        SERVICE_URL: serviceUrl,
        OAUTH_SERVER_URL: oauthServerUrl,
        ORGANIZATION_ID: organizationId,
      },
    });

    httpApi.addRoutes({
      path: "/.well-known/oauth-protected-resource",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "PrmIntegration",
        prmLambda
      ),
    });

    // MCP route (existing)
    httpApi.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: httpAuthorizer,
    });

    // Public agent-loop routes (NO JWT authorizer). The multi-tenant connector's
    // dumb local poller (the `dilaya` CLI) exchanges a single-use setup token and
    // polls "is there work?" here; auth is the poll token, verified inside the
    // Lambda (agent-handler.ts), not a JWT. Org + app live in the PATH because
    // these calls carry no token to read the org set from. In the legacy per-org
    // app these routes were created dynamically by the org Lambda; here they are
    // STATIC — one deployment serves every org — so no runtime route creation and
    // no ApiGatewayV2 IAM on the connector role. A single catch-all covers both
    // /agent/token (POST) and /agent/poll (GET); the handler validates the exact
    // sub-path and 404s anything else. Invoke permission is the api-wide
    // `HttpApiInvokeAll` grant below.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/agent/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public Telegram routes (NO JWT authorizer). Telegram's servers POST inbound
    // updates to /o/{orgId}/{app}/telegram/webhook (authenticated by the
    // per-app secret-token header, checked in the Lambda), and the user opens
    // /o/{orgId}/{app}/telegram/setup to enter the bot token out of band (a
    // signed single-use link). Org + app live in the PATH; these are STATIC (one
    // deployment serves every org) — no runtime route creation. Handler
    // validates the exact sub-path. Invoke permission is the api-wide
    // HttpApiInvokeAll grant below.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/telegram/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public integration-secret route (NO JWT authorizer). The USER opens
    // /o/{orgId}/{app}/secrets/setup (a signed single-use link) to enter a
    // 3rd-party API key out of band; the connector Lambda writes it straight to
    // SSM SecureString (never into MCP). Org + app live in the PATH; STATIC (one
    // deployment serves every org) — no runtime route creation. Handler validates
    // the exact sub-path. Invoke permission is the api-wide HttpApiInvokeAll grant
    // below; the connector role's existing /dilaya/*/apps/* SSM Put/Delete grant
    // covers the /secrets/<name> write path (no IAM delta needed).
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/secrets/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Allow API Gateway to invoke the org Lambda on ANY route of this API.
    // HttpLambdaIntegration only grants a route-specific permission for /mcp,
    // but the org Lambda creates additional routes at runtime that target
    // itself (e.g. per-app Telegram webhooks at /{schema}/telegram/{proxy+}).
    // Without an api-scoped permission those routes return 500 (API Gateway
    // cannot invoke the Lambda), and the org Lambda cannot self-grant
    // (its lambda:AddPermission IAM is scoped to per-app function names only).
    fn.addPermission("HttpApiInvokeAll", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*`,
    });

    // -----------------------------------------------------------------------
    // Frontend Authorizer + Auth Lambda (for per-app Lambdas)
    // -----------------------------------------------------------------------

    // These are created at CDK time. Their IDs are passed to the org Lambda
    // so it can create per-app API Gateway routes dynamically.
    //
    // Un-guarded (F3): per-app Cognito pools are created at RUNTIME by enable-auth,
    // so there is NO deploy-time pool to gate on — the shared frontend authorizer +
    // auth Lambda are created UNCONDITIONALLY. Each resolves the per-app pool from
    // the request PATH → registry (name#<app>) → the app's `_auth_config` row
    // (SQLite, via the VM Data API). Both MINT their own capability token; they are
    // trusted deploy-package infra, not agent code. `frontendAuthorizerId` /
    // `authIntegrationId` are exported to the connector `fn` env for F3a route
    // plumbing (setSiteRoutesAuth / ensureAuthRoute).

    let frontendAuthorizerId: string | undefined;
    let authIntegrationId: string | undefined;
    // Outer-scope ref so the APP_STATE_TABLE grant (for the per-app agent-session
    // secret) can be attached after that table is created further down.
    let frontendAuthorizerRef: lambda.Function | undefined;

    {
      // Frontend Authorizer Lambda (multi-tenant: per-app pool lookup via the
      // registry + the app's SQLite `_auth_config`; validates the Cognito ID-token
      // cookie against that pool's JWKS, plus the `dilaya_agent` HMAC session).
      const frontendAuthorizerFn = new lambda.Function(
        this,
        "FrontendAuthorizerHandler",
        {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: lambda.Code.fromAsset(
            path.join(__dirname, "frontend-authorizer")
          ),
          memorySize: 128,
          timeout: cdk.Duration.seconds(10),
          environment: {
            awsRegion: this.region,
            COGNITO_REGION: cognitoRegion,
            dataApiUrl: plainEnv["dataApiUrl"] ?? "",
            registryTableName: plainEnv["registryTableName"] ?? "",
            capabilitySecretArn: capSecretName,
            // App-content origin lock: when set, the authorizer denies direct
            // (non-vanity-edge) requests to site/auth routes, so tenant frontends
            // answer only via <app>--<org>.<appContentDomain>, never app.dilaya.eu.
            appContentDomain: appContentDomain ?? "",
          },
        }
      );
      frontendAuthorizerRef = frontendAuthorizerFn;

      // Apply the SQLite-data package IAM (Data API execute-api + registry
      // GetItem + capability-secret GetSecretValue) + S3 read so the authorizer
      // can resolve the app, read `_auth_config`, and mint capability tokens.
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          frontendAuthorizerFn.addToRolePolicy(
            iam.PolicyStatement.fromJson(statement)
          );
        }
      }
      // Read the capability signing secret so the authorizer can mint tokens.
      if (capSecretEntry) capSecretEntry.secret.grantRead(frontendAuthorizerFn);

      // Grant API Gateway permission to invoke the frontend authorizer
      frontendAuthorizerFn.addPermission("ApiGwAuthorizerInvoke", {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*`,
      });

      // Frontend Authorizer as L1 construct (to get authorizer ID)
      const frontendAuthorizerCfn = new apigwv2.CfnAuthorizer(
        this,
        "FrontendAuthorizerCfn",
        {
          apiId: httpApi.apiId,
          authorizerType: "REQUEST",
          authorizerUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${frontendAuthorizerFn.functionArn}/invocations`,
          authorizerPayloadFormatVersion: "2.0",
          enableSimpleResponses: true,
          authorizerResultTtlInSeconds: 0,
          identitySource: [] as string[], // empty = always invoke (supports public endpoints)
          name: "FrontendAuthorizerV2",
        }
      );
      frontendAuthorizerId = frontendAuthorizerCfn.ref;

      // Auth Lambda (login / send-otp / verify / logout). Multi-tenant: extracts
      // orgId + app from the path (`/o/{orgId}/{app}/auth/...`), resolves the app
      // via the registry, reads the per-app pool client + from_email from the
      // app's SQLite `_auth_config`, the allowlist from `_user_access`, and the
      // Postmark server token from SSM `/dilaya/<orgId>/apps/<app>/auth/...`.
      const authLambdaFn = new lambda.Function(this, "AuthLambdaHandler", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "auth-lambda")),
        memorySize: 128,
        timeout: cdk.Duration.seconds(15),
        environment: {
          awsRegion: this.region,
          COGNITO_REGION: cognitoRegion,
          dataApiUrl: plainEnv["dataApiUrl"] ?? "",
          registryTableName: plainEnv["registryTableName"] ?? "",
          capabilitySecretArn: capSecretName,
          customDomain: customDomain ?? "",
          bucketName: plainEnv["bucketName"] ?? "",
          s3Prefix: plainEnv["s3Prefix"] ?? "",
        },
      });

      // Apply the SQLite-data package IAM (Data API + registry + capability
      // secret) + S3 read so the auth Lambda can resolve the app, read
      // `_auth_config`/`_user_access`, and mint capability tokens.
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
        }
      }
      // Read the capability signing secret so the auth Lambda can mint tokens.
      if (capSecretEntry) capSecretEntry.secret.grantRead(authLambdaFn);

      // Read per-app Postmark server tokens from SSM SecureString. Multi-tenant:
      // one auth Lambda serves every org, so it needs /dilaya/<anyOrg>/apps/* —
      // per-org isolation is enforced in code (the SSM path is always built from
      // the path-derived orgId, never caller input). Mirrors the connector fn's
      // agent/telegram SSM grant.
      authLambdaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/dilaya/*/apps/*`,
          ],
        })
      );
      authLambdaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt"],
          resources: ["*"],
          conditions: {
            StringEquals: {
              "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
            },
          },
        })
      );

      // Allow InitiateAuth / RespondToAuthChallenge against any per-app pool
      // in this account (pool ARNs are created at runtime by enable-auth).
      authLambdaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "cognito-idp:InitiateAuth",
            "cognito-idp:RespondToAuthChallenge",
          ],
          resources: ["*"],
        })
      );

      // Grant API Gateway permission to invoke auth Lambda
      authLambdaFn.addPermission("ApiGwInvoke", {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*`,
      });

      // Auth Lambda integration as L1 construct (to get integration ID)
      const authIntegrationCfn = new apigwv2.CfnIntegration(
        this,
        "AuthIntegrationCfn",
        {
          apiId: httpApi.apiId,
          integrationType: "AWS_PROXY",
          integrationUri: authLambdaFn.functionArn,
          payloadFormatVersion: "2.0",
        }
      );
      authIntegrationId = authIntegrationCfn.ref;
    }

    // -----------------------------------------------------------------------
    // Org Lambda: per-app Lambda management permissions
    // -----------------------------------------------------------------------

    const appLambdaArnPattern = `arn:aws:lambda:${this.region}:${this.account}:function:${appLambdaNamePrefix}*`;

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunction",
          "lambda:DeleteFunction",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:InvokeFunction",
        ],
        resources: [appLambdaArnPattern],
      })
    );

    // Lambda layer access (needed when creating per-app Lambdas with layers)
    if (runtimeLayer) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["lambda:GetLayerVersion"],
          resources: [runtimeLayer.layerVersionArn],
        })
      );
    }

    // API Gateway route management
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "apigateway:POST",
          "apigateway:DELETE",
          "apigateway:GET",
          "apigateway:PATCH",
        ],
        resources: [
          `arn:aws:apigateway:${this.region}::/apis/${httpApi.apiId}/*`,
        ],
      })
    );

    // Per-app role management. The connector creates/tears down one IAM role per
    // (org,app) — but ONLY under `appRolePath`, and CreateRole is CONDITIONED on
    // attaching the permissions boundary, so it can never mint an unbounded or
    // out-of-path role (no privilege escalation from this grant).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateRole"],
        resources: [`arn:aws:iam::${this.account}:role${appRolePath}*`],
        conditions: { StringEquals: { "iam:PermissionsBoundary": appLambdaBoundary.managedPolicyArn } },
      })
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:TagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:GetRole"],
        resources: [`arn:aws:iam::${this.account}:role${appRolePath}*`],
      })
    );
    // Pass a per-app role to Lambda only (never to any other service/principal).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [`arn:aws:iam::${this.account}:role${appRolePath}*`],
        conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
      })
    );

    // -----------------------------------------------------------------------
    // SSM SecureString for per-app secrets (Telegram bot tokens, etc.).
    // Legacy per-org (organizationId set): tightly bound to that one org's
    // /hereya/{org}/apps/*. Multi-tenant connector (organizationId empty): the
    // single Lambda serves every org, so it needs /dilaya/<anyOrg>/apps/* —
    // per-org isolation is enforced in code (the SSM path is always built from
    // the chokepoint-resolved orgId, never caller input).
    // -----------------------------------------------------------------------

    const agentSecretSsmArn = organizationId
      ? `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/${organizationId}/apps/*`
      : `arn:aws:ssm:${this.region}:${this.account}:parameter/dilaya/*/apps/*`;

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ],
        resources: [agentSecretSsmArn],
      })
    );

    // NOTE(F3): per-app Lambdas intentionally get NO SSM/KMS/Cognito grants in
    // public v1. The prior grants here were cross-tenant (ssm:GetParameter on
    // /dilaya/*/apps/* reaches every org's secrets; the Cognito grant keyed off
    // an empty organizationId). F3 (per-app auth + secrets) re-adds them scoped
    // per-org via the same capability/tag discipline used for the DB.

    // KMS decrypt for the AWS-managed SSM key (SecureString).
    // Scoped via ViaService condition so it only works through SSM.
    const ssmKmsDecrypt = new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
        },
      },
    });
    fn.addToRolePolicy(ssmKmsDecrypt);
    // (per-app Lambda SSM/KMS/Cognito grants removed — see NOTE(F3) above; each
    //  per-app role is created at runtime by the connector, capped by the boundary.)

    // -----------------------------------------------------------------------
    // Org Lambda: environment variables for per-app Lambda management
    // -----------------------------------------------------------------------

    fn.addEnvironment("APP_LAMBDA_ROLE_PATH", appRolePath);
    fn.addEnvironment("APP_LAMBDA_PERMISSIONS_BOUNDARY_ARN", appLambdaBoundary.managedPolicyArn);
    fn.addEnvironment("APP_LAMBDA_NAME_PREFIX", appLambdaNamePrefix);
    if (runtimeLayer) {
      fn.addEnvironment("APP_LAMBDA_LAYER_ARN", runtimeLayer.layerVersionArn);
    }
    fn.addEnvironment("HTTP_API_ID", httpApi.apiId);
    fn.addEnvironment("AWS_ACCOUNT_ID", this.account);
    fn.addEnvironment("ORGANIZATION_ID", organizationId);
    fn.addEnvironment("AGENT_SECRET_SSM_PREFIX", `/hereya/${organizationId}/apps`);
    fn.addEnvironment("COGNITO_TRIGGER_LAMBDA_ARNS", triggerArns.join(","));
    fn.addEnvironment("awsRegion", this.region);
    // Cognito region for enable-auth (app-auth.ts reads COGNITO_REGION ?? awsRegion).
    fn.addEnvironment("COGNITO_REGION", cognitoRegion);

    if (frontendAuthorizerId) {
      fn.addEnvironment("FRONTEND_AUTHORIZER_ID", frontendAuthorizerId);
    }
    if (authIntegrationId) {
      fn.addEnvironment("AUTH_INTEGRATION_ID", authIntegrationId);
    }

    // -----------------------------------------------------------------------
    // Per-app lightweight state table (DynamoDB, on-demand). Used for cheap
    // "is there something new?" flags so polling loops don't have to query
    // Aurora (which would keep it from scaling to zero). Org-scoped (one table
    // per deployment); items are keyed per app via the partition key.
    // -----------------------------------------------------------------------
    const appStateTable = new dynamodb.Table(this, "AppStateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    fn.addEnvironment("APP_STATE_TABLE", appStateTable.tableName);
    appStateTable.grantReadWriteData(fn);

    // The frontend authorizer reads the per-app agent-session HMAC secret
    // (`appsecret#<orgId>#<app>`, written by the connector's ensureAppSecret) to
    // validate the `dilaya_agent` browser-testing session cookie. Read-only.
    if (frontendAuthorizerRef) {
      frontendAuthorizerRef.addEnvironment(
        "APP_STATE_TABLE",
        appStateTable.tableName
      );
      appStateTable.grantReadData(frontendAuthorizerRef);
    }

    // -----------------------------------------------------------------------
    // Org Lambda: per-app auth provisioning permissions (enable-auth tool).
    //
    // Per-app Cognito pools + clients are created at runtime (resources are
    // only known after CreateUserPool succeeds), so resource="*". The org
    // Lambda needs to attach the shared trigger Lambdas to each new pool
    // (AddPermission) and clean them up on drop-schema (RemovePermission).
    // -----------------------------------------------------------------------

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:CreateUserPool",
          "cognito-idp:DeleteUserPool",
          "cognito-idp:UpdateUserPool",
          "cognito-idp:DescribeUserPool",
          "cognito-idp:ListUserPools",
          "cognito-idp:CreateUserPoolClient",
          "cognito-idp:DeleteUserPoolClient",
          "cognito-idp:UpdateUserPoolClient",
          "cognito-idp:DescribeUserPoolClient",
          "cognito-idp:AdminCreateUser",
          // AdminDeleteUser: remove-user-access tool + runtime users helper.
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:ListUsers",
          "cognito-idp:TagResource",
          // SetUserPoolMfaConfig: reserved for the passwordless-OTP MFA config
          // path (CreateUserPool sets MfaConfiguration OFF inline today; kept so
          // a future enable-auth MFA tweak doesn't need a redeploy).
          "cognito-idp:SetUserPoolMfaConfig",
        ],
        // Multi-tenant: per-app pools are created at RUNTIME for every org, each
        // TAGGED HereyaOrg/HereyaApp, so there is no single org value to scope to
        // (organizationId is empty). resource="*"; per-org isolation is enforced
        // in code (app-auth.ts tags every pool with the chokepoint-resolved orgId).
        resources: ["*"],
      })
    );

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:AddPermission", "lambda:RemovePermission"],
        resources: triggerArns,
      })
    );

    // -----------------------------------------------------------------------
    // Custom domain + DNS
    // -----------------------------------------------------------------------

    if (customDomain && customDomainZone) {
      if (!wildcardCertificateArn) {
        throw new Error(
          "wildcardCertificateArn is required when customDomain is set"
        );
      }

      const certificate = acm.Certificate.fromCertificateArn(
        this,
        "Certificate",
        wildcardCertificateArn
      );

      const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomainZone,
      });

      // Expose hosted zone ID + grant Route53 record-set management so the
      // org Lambda can write DKIM + return-path records when provisioning
      // per-app Postmark domains via enable-auth.
      fn.addEnvironment("HOSTED_ZONE_ID", hostedZone.hostedZoneId);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "route53:ChangeResourceRecordSets",
            "route53:ListResourceRecordSets",
            "route53:GetHostedZone",
          ],
          resources: [
            `arn:aws:route53:::hostedzone/${hostedZone.hostedZoneId}`,
          ],
        })
      );

      // API Gateway custom domain for MCP (exact domain)
      const domainName = new apigwv2.DomainName(this, "DomainName", {
        domainName: customDomain,
        certificate,
      });

      new apigwv2.ApiMapping(this, "ApiMapping", {
        api: httpApi,
        domainName,
      });

      new route53.ARecord(this, "AliasRecord", {
        zone: hostedZone,
        recordName: customDomain,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            domainName.regionalDomainName,
            domainName.regionalHostedZoneId
          )
        ),
      });

      // -------------------------------------------------------------------
      // App-content domain: host-routing (FLAT scheme) — additive vanity host.
      //
      // A dedicated CloudFront distribution (alt name `*.<appContentDomain>`,
      // wildcard viewer cert) fronts the SAME API-Gateway custom-domain origin
      // (`customDomain`, e.g. app.dilaya.eu) that the path URL already uses — the
      // origin Host stays `customDomain` so API-GW domain/routing still matches.
      // A CloudFront FUNCTION (viewer-request) holds a BAKED host->{org,app} map
      // and rewrites the URI to the existing per-app site/auth routes
      // (/o/<org>/<app>/{site|auth}/…), tagging the viewer host in the
      // `x-dilaya-app-host` header. The connector regenerates the map at runtime
      // via UpdateFunction/PublishFunction — ONLY the `var HOSTMAP = {};` object
      // literal is swapped, so keep the surrounding source byte-stable. The cert
      // + wildcard DNS are static (one label under the domain) and never change
      // as apps/orgs are added. Entire feature is gated on `appContentDomain`.
      // -------------------------------------------------------------------

      if (appContentDomain) {
        if (!appContentCertArn) {
          throw new Error(
            "appContentCertArn is required when appContentDomain is set"
          );
        }
        if (!appContentZoneId) {
          throw new Error(
            "appContentZoneId is required when appContentDomain is set"
          );
        }

        // Pre-created us-east-1 wildcard cert (passed in, NOT created by CDK).
        const appContentCertificate = acm.Certificate.fromCertificateArn(
          this,
          "AppContentCertificate",
          appContentCertArn
        );

        // Attribute import (no context lookup) — the zone for appContentDomain.
        const appContentZone = route53.HostedZone.fromHostedZoneAttributes(
          this,
          "AppContentZone",
          { hostedZoneId: appContentZoneId, zoneName: appContentDomain }
        );

        // Viewer-request CloudFront Function. This is the BOOTSTRAP version with
        // an EMPTY host map (`var HOSTMAP = {};`). The connector rewrites just
        // that object literal at runtime (DescribeFunction -> UpdateFunction ->
        // PublishFunction), keeping every other byte identical. The executable
        // body matches the build contract exactly.
        const appHostRouterFn = new cloudfront.Function(this, "AppHostRouter", {
          functionName: `${appLambdaNamePrefix}apphost-router`,
          code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var HOSTMAP = {};
  var e = HOSTMAP[host];
  if (!e) return request;                 // unknown host -> passthrough -> origin 404
  var uri = request.uri;                  // e.g. "/e/foo" or "/auth/login" or "/"
  // auth routes live at /o/<org>/<app>/auth/... ; everything else at /o/<org>/<app>/site/...
  var prefix = uri === '/auth' || uri.indexOf('/auth/') === 0
      ? '/o/' + e.o + '/' + e.a
      : '/o/' + e.o + '/' + e.a + '/site';
  request.uri = prefix + uri;             // "/o/<org>/<app>/site/e/foo"
  request.headers['x-dilaya-app-host'] = { value: host };  // carry viewer host to origin
  return request;
}`),
        });

        // Same API-GW custom-domain origin as the path URL. Default HttpOrigin
        // Host = `customDomain`, so API Gateway's domain mapping still matches.
        const appContentDistribution = new cloudfront.Distribution(
          this,
          "AppContentDistribution",
          {
            certificate: appContentCertificate,
            domainNames: [`*.${appContentDomain}`],
            defaultBehavior: {
              origin: new origins.HttpOrigin(customDomain, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy:
                cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
              originRequestPolicy: new cloudfront.OriginRequestPolicy(
                this,
                "AppContentOriginPolicy",
                {
                  // The frontend session cookies the auth Lambda sets +
                  // the frontend authorizer reads (dilaya_* current, hereya_id_token
                  // legacy). CloudFront strips any cookie not listed.
                  cookieBehavior:
                    cloudfront.OriginRequestCookieBehavior.allowList(
                      "dilaya_id_token",
                      "hereya_id_token",
                      "dilaya_agent"
                    ),
                  // Base forwarded set + `x-dilaya-app-host` (added to
                  // frontendForwardHeaders above when appContentDomain is set).
                  headerBehavior:
                    cloudfront.OriginRequestHeaderBehavior.allowList(
                      ...frontendForwardHeaders
                    ),
                  queryStringBehavior:
                    cloudfront.OriginRequestQueryStringBehavior.all(),
                }
              ),
              functionAssociations: [
                {
                  function: appHostRouterFn,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            },
          }
        );

        // Route53 wildcard A + AAAA -> the content distribution.
        new route53.ARecord(this, "AppContentWildcardA", {
          zone: appContentZone,
          recordName: `*.${appContentDomain}`,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(appContentDistribution)
          ),
        });
        new route53.AaaaRecord(this, "AppContentWildcardAAAA", {
          zone: appContentZone,
          recordName: `*.${appContentDomain}`,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(appContentDistribution)
          ),
        });

        // --- Connector fn env: the connector regenerates the host map at
        //     runtime, so it needs the function name + distribution id.
        fn.addEnvironment("APP_CONTENT_DOMAIN", appContentDomain);
        fn.addEnvironment(
          "APP_CONTENT_CF_FUNCTION_NAME",
          appHostRouterFn.functionName
        );
        fn.addEnvironment(
          "APP_CONTENT_DISTRIBUTION_ID",
          appContentDistribution.distributionId
        );

        // --- IAM (connector fn role): update ONLY this content function's code
        //     (the baked HOSTMAP). Scoped to the function ARN — nothing else new.
        //     GetFunction is required: regenerateHostMap reads the current code
        //     bytes (GetFunction) to swap only the `var HOSTMAP = {};` line;
        //     DescribeFunction returns config+ETag but NOT the code.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "cloudfront:GetFunction",
              "cloudfront:DescribeFunction",
              "cloudfront:UpdateFunction",
              "cloudfront:PublishFunction",
            ],
            resources: [
              `arn:aws:cloudfront::${this.account}:function/${appHostRouterFn.functionName}`,
            ],
          })
        );

        new cdk.CfnOutput(this, "AppContentDistributionDomain", {
          value: appContentDistribution.distributionDomainName,
        });
        new cdk.CfnOutput(this, "AppContentCfFunctionName", {
          value: appHostRouterFn.functionName,
        });
      }

      // -------------------------------------------------------------------
      // CloudFront distribution for frontend (*.{customDomain})
      // -------------------------------------------------------------------

      if (cognitoUserPoolId && cognitoClientId) {
        const cloudfrontCertificate = new acm.DnsValidatedCertificate(
          this,
          "CloudFrontCertificate",
          {
            domainName: `*.${customDomain}`,
            hostedZone,
            region: "us-east-1",
          }
        );

        // CloudFront Function: extract app subdomain → prepend to path, and
        // (when the org Lambda regenerates the code) route custom vanity
        // domains via a per-host domainMap lookup.
        //
        // This inline code is the BOOTSTRAP version with an empty domainMap.
        // On the first `set-custom-domains`/`check-custom-domains` cycle the
        // org Lambda overwrites this function with a regenerated version that
        // contains the active domain→schema mapping. The shape must match
        // src/custom-domain-template.ts in the hereya-apps repo so runtime
        // updates are drop-in replacements.
        const cfFunction = new cloudfront.Function(this, "SubdomainRewrite", {
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var customDomain = ${JSON.stringify(customDomain)};
  var domainMap = {};
  if (domainMap[host]) {
    request.uri = '/' + domainMap[host] + request.uri;
    return request;
  }
  if (host !== customDomain && host.endsWith('.' + customDomain)) {
    var appName = host.slice(0, -(customDomain.length + 1));
    request.uri = '/' + appName + request.uri;
  }
  return request;
}
          `),
          functionName: `${this.stackName}-subdomain-rewrite`,
        });

        // API Gateway origin
        const apiDomainName = cdk.Fn.select(
          2,
          cdk.Fn.split("/", httpApi.apiEndpoint)
        );

        const distribution = new cloudfront.Distribution(
          this,
          "FrontendDistribution",
          {
            certificate: cloudfrontCertificate,
            domainNames: [`*.${customDomain}`],
            defaultBehavior: {
              origin: new origins.HttpOrigin(apiDomainName, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy:
                cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
              originRequestPolicy: new cloudfront.OriginRequestPolicy(
                this,
                "FrontendOriginPolicy",
                {
                  cookieBehavior:
                    cloudfront.OriginRequestCookieBehavior.allowList(
                      "hereya_id_token",
                      "hereya_agent"
                    ),
                  // Base set + `additionalForwardedHeaders` (built at the top of
                  // the constructor). CloudFront strips any header not whitelisted
                  // here, so custom auth/webhook headers (x-forwarded-host for
                  // vanity-host login cookies; X-Telegram-Bot-Api-Secret-Token for
                  // the Telegram webhook; X-Dilaya-Agent-Token for the agent poll)
                  // must appear in this list or the origin never sees them.
                  headerBehavior:
                    cloudfront.OriginRequestHeaderBehavior.allowList(
                      ...frontendForwardHeaders
                    ),
                  queryStringBehavior:
                    cloudfront.OriginRequestQueryStringBehavior.all(),
                }
              ),
              functionAssociations: [
                {
                  function: cfFunction,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            },
          }
        );

        // Route53 wildcard -> CloudFront
        new route53.ARecord(this, "WildcardAliasRecord", {
          zone: hostedZone,
          recordName: `*.${customDomain}`,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(distribution)
          ),
        });

        new cdk.CfnOutput(this, "FrontendDistributionDomain", {
          value: distribution.distributionDomainName,
        });

        // -----------------------------------------------------------------
        // Custom-domain support wiring
        //
        // The org Lambda exposes MCP tools that swap the distribution's
        // ViewerCertificate in-place when users request vanity domains. We:
        //   1. Seed an SSM param with the bootstrap wildcard cert ARN on
        //      first deploy (onUpdate is a no-op → subsequent deploys don't
        //      overwrite the Lambda's live cert ARN).
        //   2. Grant the org Lambda ACM (tag-scoped) + CloudFront (ARN-scoped)
        //      + SSM (path-scoped) permissions.
        //   3. Pass distribution + function identifiers + SSM path through env.
        //
        // NOTE on drift: if a future CDK stack change touches the Distribution
        // or the CF function, CloudFormation will re-send CDK's inline config
        // and overwrite the Lambda's live state. Remediation is to re-run
        // `check-custom-domains` after the stack update.
        // -----------------------------------------------------------------

        const viewerCertSsmParamName = `/hereya/${organizationId}/viewer-cert-arn`;
        const viewerCertSsmParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${viewerCertSsmParamName}`;

        const seedViewerCertArn = new cr.AwsCustomResource(
          this,
          "ViewerCertSsmSeed",
          {
            onCreate: {
              service: "SSM",
              action: "PutParameter",
              parameters: {
                Name: viewerCertSsmParamName,
                Value: cloudfrontCertificate.certificateArn,
                Type: "String",
                Overwrite: false,
              },
              physicalResourceId: cr.PhysicalResourceId.of(
                `viewer-cert-seed-${organizationId}`
              ),
              ignoreErrorCodesMatching: "ParameterAlreadyExists",
            },
            onUpdate: {
              service: "SSM",
              action: "GetParameter",
              parameters: { Name: viewerCertSsmParamName },
              physicalResourceId: cr.PhysicalResourceId.of(
                `viewer-cert-seed-${organizationId}`
              ),
              ignoreErrorCodesMatching: "ParameterNotFound",
            },
            onDelete: {
              service: "SSM",
              action: "DeleteParameter",
              parameters: { Name: viewerCertSsmParamName },
              ignoreErrorCodesMatching: "ParameterNotFound",
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
              new iam.PolicyStatement({
                actions: [
                  "ssm:PutParameter",
                  "ssm:GetParameter",
                  "ssm:DeleteParameter",
                ],
                resources: [viewerCertSsmParamArn],
              }),
            ]),
            installLatestAwsSdk: false,
          }
        );
        seedViewerCertArn.node.addDependency(cloudfrontCertificate);

        // --- ACM (tag-scoped): any cert the org Lambda creates must be
        //     tagged with its own orgId; all non-create actions are gated on
        //     the same tag matching on the resource. This prevents org A from
        //     touching org B's certs.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "acm:RequestCertificate",
              "acm:AddTagsToCertificate",
            ],
            resources: ["*"],
            conditions: {
              StringEquals: {
                "aws:RequestTag/hereya:orgId": organizationId,
              },
              "ForAllValues:StringEquals": {
                "aws:TagKeys": [
                  "hereya:orgId",
                  "hereya:schema",
                  "hereya:domains",
                ],
              },
            },
          })
        );
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "acm:DescribeCertificate",
              "acm:DeleteCertificate",
              "acm:ListTagsForCertificate",
            ],
            resources: [
              `arn:aws:acm:us-east-1:${this.account}:certificate/*`,
            ],
            conditions: {
              StringEquals: {
                "aws:ResourceTag/hereya:orgId": organizationId,
              },
            },
          })
        );

        // --- CloudFront (ARN-scoped): the org Lambda may only update ITS
        //     own distribution and function.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "cloudfront:GetDistribution",
              "cloudfront:GetDistributionConfig",
              "cloudfront:UpdateDistribution",
            ],
            resources: [
              `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
            ],
          })
        );
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "cloudfront:GetFunction",
              "cloudfront:DescribeFunction",
              "cloudfront:UpdateFunction",
              "cloudfront:PublishFunction",
            ],
            resources: [
              `arn:aws:cloudfront::${this.account}:function/${cfFunction.functionName}`,
            ],
          })
        );

        // --- SSM (path-scoped): write the cert ARN on swap.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["ssm:GetParameter", "ssm:PutParameter"],
            resources: [viewerCertSsmParamArn],
          })
        );

        // --- Expose IDs to the org Lambda.
        fn.addEnvironment(
          "CLOUDFRONT_DISTRIBUTION_ID",
          distribution.distributionId
        );
        fn.addEnvironment("CLOUDFRONT_FUNCTION_NAME", cfFunction.functionName);
        fn.addEnvironment(
          "CLOUDFRONT_DOMAIN",
          distribution.distributionDomainName
        );
        fn.addEnvironment("VIEWER_CERT_SSM_PARAM", viewerCertSsmParamName);
        fn.node.addDependency(seedViewerCertArn);
      }

      new cdk.CfnOutput(this, "ServiceUrl", {
        value: `https://${customDomain}`,
      });
    } else {
      new cdk.CfnOutput(this, "ServiceUrl", {
        value: httpApi.apiEndpoint,
      });
    }
  }
}

function extractDomainZone(
  customDomain: string | undefined
): string | undefined {
  if (!customDomain) return undefined;
  const parts = customDomain.split(".");
  if (parts.length < 2) throw new Error("Invalid domain name: " + customDomain);
  return parts.length === 2 ? customDomain : parts.slice(1).join(".");
}
