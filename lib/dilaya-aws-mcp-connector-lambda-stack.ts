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
    // Shared IAM Role for per-app Lambdas
    // -----------------------------------------------------------------------

    const appLambdaRole = new iam.Role(this, "AppLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "AppLambdaBasicExec",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Per-app frontend Lambdas get a STRICT ALLOWLIST — never the connector's
    // broad dependency grants. Handing a per-app Lambda the SQLite VM family
    // (iamPolicySqliteDataApi = all-apps DB, iamPolicySqliteRegistry = the org/app
    // registry, iamPolicySqliteCapability = the token SIGNING SECRET) would let it
    // reach any org's data — or forge a capability token for any (org,app) and
    // break tenant isolation entirely. Its DB access is instead a narrow,
    // data-routes-only execute-api grant to the VM, with its (org,app) bound
    // per-request by the long-lived capability token in its env. (Auth/secrets
    // grants come back, per-org-scoped, in F3.)
    const dataApiUrl = nonPolicyEnv["dataApiUrl"];
    if (dataApiUrl) {
      const vmApiId = new URL(dataApiUrl).host.split(".")[0];
      // Only the data routes — NOT /admin/* (delete-app, sync are connector-only).
      const dataRoutes = [
        "POST/query",
        "POST/batch-execute",
        "POST/tx/begin",
        "POST/tx/commit",
        "POST/tx/rollback",
        "GET/stats",
      ];
      appLambdaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["execute-api:Invoke"],
          resources: dataRoutes.map(
            (r) => `arn:aws:execute-api:${this.region}:${this.account}:${vmApiId}/*/${r}`
          ),
        })
      );
    }
    // Files: the per-app runtime stores/reads objects under its own org prefix.
    // NOTE: the shared per-app role can't bake in a specific orgId, so the IAM
    // grant is storage-prefix-wide; per-org file isolation is enforced in code
    // (runtime/storage.ts prefixes every key with <orgId>/). True per-org S3 IAM
    // would need per-app roles or an S3 capability — a documented v1 limitation.
    const appBucket = nonPolicyEnv["bucketName"];
    const appPrefix = nonPolicyEnv["s3Prefix"];
    if (appBucket) {
      const keyGlob = `arn:aws:s3:::${appBucket}/${appPrefix ? appPrefix + "/" : ""}*`;
      appLambdaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [keyGlob],
        })
      );
      appLambdaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [`arn:aws:s3:::${appBucket}`],
          conditions: appPrefix
            ? { StringLike: { "s3:prefix": [`${appPrefix}/*`, `${appPrefix}`] } }
            : undefined,
        })
      );
    }

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

    let frontendAuthorizerId: string | undefined;
    let authIntegrationId: string | undefined;

    if (cognitoUserPoolId && cognitoClientId) {
      // Frontend Authorizer Lambda (multi-tenant: per-app pool lookup via DB,
      // with shared-pool fallback for Phase-A migration).
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
            COGNITO_USER_POOL_ID: cognitoUserPoolId,
            COGNITO_REGION: cognitoRegion,
            clusterArn: plainEnv["clusterArn"] ?? "",
            secretArn: plainEnv["secretArn"] ?? "",
            databaseName: plainEnv["databaseName"] ?? "",
          },
        }
      );

      // Apply Aurora Data API policies from dep packages so the authorizer can
      // SELECT from public._app_auth.
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          frontendAuthorizerFn.addToRolePolicy(
            iam.PolicyStatement.fromJson(statement)
          );
        }
      }

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

      // Auth Lambda (login/OTP/verify/logout). Multi-tenant: extracts app from
      // path, looks up per-app pool client + Postmark token, falls back to the
      // shared org pool for unmigrated apps.
      const authLambdaEnv: Record<string, string> = {
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        COGNITO_CLIENT_ID: cognitoClientId,
        COGNITO_REGION: cognitoRegion,
        CUSTOM_DOMAIN: customDomain ?? "",
        BUCKET_NAME: plainEnv["bucketName"] ?? "",
        S3_PREFIX: plainEnv["s3Prefix"] ?? "",
        ORGANIZATION_ID: organizationId,
        clusterArn: plainEnv["clusterArn"] ?? "",
        secretArn: plainEnv["secretArn"] ?? "",
        databaseName: plainEnv["databaseName"] ?? "",
      };

      const authLambdaFn = new lambda.Function(this, "AuthLambdaHandler", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "auth-lambda")),
        memorySize: 128,
        timeout: cdk.Duration.seconds(15),
        environment: authLambdaEnv,
      });

      // Grant Auth Lambda access to secrets
      const authSecretKeys: string[] = [];
      for (const { key, secret, secretName } of secretEnvEntries) {
        authLambdaFn.addEnvironment(key, secretName);
        secret.grantRead(authLambdaFn);
        authSecretKeys.push(key);
      }
      if (authSecretKeys.length > 0) {
        authLambdaFn.addEnvironment("SECRET_KEYS", authSecretKeys.join(","));
      }

      // Grant Auth Lambda Cognito permissions + Data API (to read _app_auth).
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
        }
      }

      // Read per-app Postmark server token from SSM SecureString.
      const appAuthSsmArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/${organizationId}/apps/*`;
      authLambdaFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [appAuthSsmArn],
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

    // Pass shared role to per-app Lambdas
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [appLambdaRole.roleArn],
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
    // (appLambdaRole KMS + Cognito grants removed — see NOTE(F3) above.)

    // -----------------------------------------------------------------------
    // Org Lambda: environment variables for per-app Lambda management
    // -----------------------------------------------------------------------

    fn.addEnvironment("APP_LAMBDA_ROLE_ARN", appLambdaRole.roleArn);
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
          "cognito-idp:ListUsers",
          "cognito-idp:TagResource",
        ],
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
