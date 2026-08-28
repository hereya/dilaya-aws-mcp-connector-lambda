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
import * as triggers from "aws-cdk-lib/triggers";
import * as ssmparam from "aws-cdk-lib/aws-ssm";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
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
    // Un-forgeable origin lock (optional). When set (and appContentDomain is set),
    // the app-content CloudFront distribution stamps this SECRET on every edge->origin
    // request as `x-dilaya-origin-verify`, and the frontend authorizer requires it on
    // site/auth routes. A direct hit on the first-party path URL can't reproduce the
    // secret, so it's denied — unlike the plain `x-dilaya-app-host` marker, which a
    // client can hand-forge. Absent → the authorizer keeps the marker-presence gate.
    const appContentOriginSecret = process.env["appContentOriginSecret"];
    // Transitional acceptance during a secret ROTATION: set this to the OLD
    // secret while rolling the new one (the authorizer accepts either until the
    // CloudFront origin-header updates propagate), then clear it on the next
    // deploy. Empty → strict single-secret mode.
    const appContentOriginSecretPrevious =
      process.env["appContentOriginSecretPrevious"];
    // Per-IP rate guard on tenant frontends (t_80c5ba958ad3). Both optional:
    // the authorizer carries the same defaults, so an unset deployment behaves
    // exactly as the code does. `frontendRateBlock` is the one that matters —
    // it stays "false" (COUNT only: report what WOULD have been refused) until
    // the counted data says who a block would actually cut. A per-IP limit is
    // wrong about shared addresses (corporate NAT, mobile carrier, café), so
    // turning it on is a deliberate act, never a default.
    const frontendRateLimit = process.env["frontendRateLimit"] || "1000";
    // ENFORCING unless explicitly disabled, matching the authorizer's own
    // default. The polarity matters and it bit once: while this read
    // `=== "true" ? "true" : "false"`, the stack kept STAMPING
    // FRONTEND_RATE_BLOCK="false" onto the function, so flipping the default
    // inside the authorizer changed nothing — the explicit env var won, and the
    // guard deployed green while refusing nothing. An env var the stack always
    // sets is not a default; it is an override, and it has to agree with the
    // code it overrides. Caught by reading the deployed function's config
    // rather than trusting the release.
    const frontendRateBlock =
      process.env["frontendRateBlock"] === "false" ? "false" : "true";
    // Domain purchase through Dilaya (Route 53 Domains). OPTIONAL and additive:
    // absent/false → no env, no IAM, feature fully inert connector-side (its
    // tools answer DOMAIN_PURCHASE_NOT_CONFIGURED). Only meaningful together
    // with appContentDomain (the purchased-domain wiring rides the BYOD flow).
    const domainPurchase = process.env["domainPurchase"] === "true";

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

    // Capability-rejection alarm. The VM denies a Data API call whose HMAC
    // capability token is missing/invalid; the connector logs the rejection
    // ("capability rejected: <reason>"). A burst of these took ~21h to surface
    // via the log sweep (2026-07-06 bad_signature incident) — this filter+alarm
    // turns any recurrence into a metric datapoint within minutes. `fn.logGroup`
    // pre-creates/adopts /aws/lambda/<fn> so the filter never races the lazy
    // log-group creation on a fresh stack.
    //
    // ⚠️ For its first month this alarm had NO action, on the theory that "the
    // alarm state itself is the signal". It isn't: nothing polls an alarm state.
    // The only reader was the twice-a-day log sweep — precisely the ~21h delay
    // the alarm was created to remove, and the task that shipped it recorded
    // "fires within minutes (SNS→Telegram)" for a chain that did not exist
    // (found by the 2026-08-08 sweep). It now speaks through the same relay
    // pattern that `dilaya/aws-sqlite-data` proved in prod on 2026-08-07.
    const capabilityRejectedFilter = new logs.MetricFilter(this, "CapabilityRejectedFilter", {
      logGroup: fn.logGroup,
      metricNamespace: "Dilaya/Connector",
      metricName: "CapabilityRejected",
      filterPattern: logs.FilterPattern.literal('"capability rejected"'),
      metricValue: "1",
    });
    const capabilityRejectedAlarm = new cloudwatch.Alarm(this, "CapabilityRejectedAlarm", {
      metric: capabilityRejectedFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Dilaya connector: Data API capability rejections (e.g. bad_signature) in the last 5 min — " +
        "see the 2026-07-06 incident; a poisoned Lambda env can hide behind poll-only traffic.",
    });

    // --- Alarm → SNS → Telegram -------------------------------------------
    // Both inputs are required; either one missing and no relay is built, which
    // leaves the alarm exactly as it was (visible in CloudWatch, silent). The
    // names below are read VERBATIM from the synth env — a package only ever
    // receives an input it DECLARES under `parameters:` in hereyarc.yaml, and an
    // undeclared one is dropped in silence while the deploy still goes green.
    // That is what cost three releases on 2026-08-07; the two names here match
    // `dilaya/aws-sqlite-data`'s on purpose, so the single pair of `-p` values
    // in release.yml feeds both packages.
    const alarmTelegramTokenParam = process.env["telegramBotTokenParam"] ?? "";
    const alarmTelegramChatId = process.env["telegramChatId"] ?? "";
    // The ops agent's inbox. Deliberately NOT literals in the connector's source:
    // baking one tenant's identity into product code would be a permanent wart on
    // a single deployment that serves everyone. Absent → the wake half stays off
    // and the connector REFUSES any alarm envelope (never a silent default).
    const alarmInboxOrg = process.env["alarmInboxOrg"] ?? "";
    const alarmInboxApp = process.env["alarmInboxApp"] ?? "";
    let alertTopic: sns.Topic | undefined;
    if (alarmTelegramTokenParam !== "" && alarmTelegramChatId !== "") {
      alertTopic = new sns.Topic(this, "ConnectorAlertTopic", {
        displayName: "Dilaya connector alarms",
      });
      const alarmRelay = new lambda.Function(this, "AlarmRelay", {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "alarm-relay")),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        environment: {
          TELEGRAM_TOKEN_PARAM: alarmTelegramTokenParam,
          TELEGRAM_CHAT_ID: alarmTelegramChatId,
          // Waking the ops agent is the OTHER half of an alarm: Telegram tells
          // Jonatan, this tells the agent. Empty (both params absent) → the
          // relay keeps its Telegram-only behaviour, so the two halves can ship
          // independently. See lib/alarm-relay/wake.js.
          CONNECTOR_FUNCTION_NAME: alarmInboxOrg !== "" && alarmInboxApp !== "" ? fn.functionName : "",
        },
      });
      // The ONLY new right, and it points one way: the relay may invoke the
      // connector. It carries no org and no app in its payload — the connector
      // holds the destination in its own configuration — so this grant cannot
      // reach a tenant's inbox even if the relay is compromised.
      if (alarmInboxOrg !== "" && alarmInboxApp !== "") {
        fn.grantInvoke(alarmRelay);
      }
      alarmRelay.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            cdk.Arn.format(
              {
                service: "ssm",
                resource: "parameter",
                resourceName: alarmTelegramTokenParam.replace(/^\//, ""),
              },
              this,
            ),
          ],
        }),
      );
      alertTopic.addSubscription(new snsSubs.LambdaSubscription(alarmRelay));
    }

    // Wire an alarm to the relay, in BOTH directions — an alert that never says
    // "it's over" trains you to ignore it. Alarms are created unconditionally
    // (they stay visible in CloudWatch, and other subscribers remain possible);
    // only the speaking part depends on the two inputs.
    const alertOn = (alarm: cloudwatch.Alarm): void => {
      if (!alertTopic) return;
      alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
      alarm.addOkAction(new cwActions.SnsAction(alertTopic));
    };
    alertOn(capabilityRejectedAlarm);

    // Every function that gets an Errors/Throttles alarm at the end of the
    // stack. Collected as they are built because several are created inside
    // feature-conditional blocks and would otherwise be out of scope there.
    const monitoredFunctions: { label: string; fn: lambda.Function }[] = [
      { label: "Handler", fn },
    ];

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
      // PITR for consistency with every other table this package owns (the
      // contents are TTL'd one-time codes, so it stays empty and this costs
      // nothing). RemovalPolicy stays DESTROY on purpose: nothing here outlives
      // a login attempt, so there is nothing to retain.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
    monitoredFunctions.push({ label: "McpAuthorizer", fn: authorizerFn });

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

    // Gateway-level observability. WHY this exists (2026-08-06 sweep finding):
    // a request can fail AT THE GATEWAY — a 502 from a malformed Lambda
    // response, a failed integration, a 504 integration timeout — without ever
    // reaching, or without being blamed on, the Lambda. Such a failure is
    // invisible to every instrument we had:
    //   * `AWS/Lambda Errors` counts only invocations that THREW, so it reads 0;
    //   * the connector's handler logs a per-call `{"type":"authz",…}` trace but
    //     NO per-request status line, so there is nothing to grep either.
    // The `AWS/ApiGateway 5xx` metric did see them — 20 over 7 days, including 9
    // in one hour on 2026-08-05 that two consecutive prod sweeps had read and
    // declared clean (the landing's API measured 0 over the same window, so it
    // was ours, not AWS noise). But with no access log and no per-route metrics
    // we could only count them, never say what they were.
    //
    // So: access logs (the ONLY place `integrationErrorMessage` is written down,
    // i.e. the only way to tell a 502 from a 504) + per-route detailed metrics.
    // Retention is deliberately short — the sweep reads a 7-day metric window,
    // so two weeks keeps a correlatable log line for every hit it can surface,
    // and nothing beyond that is ever read.
    const accessLogGroup = new logs.LogGroup(this, "HttpApiAccessLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Access-log settings live only on the L1 stage — `HttpApi` exposes no
    // prop for them, and `defaultStage` is created for us by `createDefaultStage`.
    const cfnDefaultStage = httpApi.defaultStage!.node
      .defaultChild as apigwv2.CfnStage;
    cfnDefaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      // One JSON object per request. Ordered by what the sweep actually reads:
      // status first, then WHY (the integration fields — a gateway 5xx with
      // `integrationStatus` absent is a different fault from one with 504), then
      // WHO (ip/ua, to separate a scanner from one of our own components).
      format: JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        path: "$context.path",
        status: "$context.status",
        integrationStatus: "$context.integrationStatus",
        integrationErrorMessage: "$context.integrationErrorMessage",
        integrationLatency: "$context.integrationLatency",
        responseLatency: "$context.responseLatency",
        errorMessage: "$context.error.message",
        authorizerError: "$context.authorizer.error",
        sourceIp: "$context.identity.sourceIp",
        userAgent: "$context.identity.userAgent",
      }),
    };
    // Per-route `5xx`/`4xx`/`Count`/`Latency`. Without this the 5xx metric
    // exists only at the API level, which is what made the 2026-08-05 burst
    // unattributable: 9 failures, no way to say whether they were /mcp or a
    // tenant site route.
    cfnDefaultStage.defaultRouteSettings = {
      ...(cfnDefaultStage.defaultRouteSettings as
        | apigwv2.CfnStage.RouteSettingsProperty
        | undefined),
      detailedMetricsEnabled: true,
      // --- The last-resort ceiling (t_09669ba18d5e) ----------------------
      // The per-IP guard in the frontend authorizer is the TARGETED defense:
      // it cuts the one address that is looping and nobody else. This is the
      // blunt one underneath it, and the two are not interchangeable.
      //
      // It is the only layer here that can answer a real **429**: an authorizer
      // does not choose its status code (a refusal is always 403), while the
      // gateway throttles natively and says "Too Many Requests" properly. But
      // it is GLOBAL — one runaway would eat the shared budget and throttle
      // every other tenant, and `/mcp` with them. So it must never be the thing
      // that fires in a normal incident; it exists for the case the targeted
      // guard cannot see (many addresses at once) or is itself broken.
      //
      // Hence a threshold with an absurd amount of headroom, not a tuned one:
      // real traffic is 500-2300 requests per DAY (~0.03/s average) and the
      // 2026-08-27 runaway peaked at 19/s. 100/s sustained with a 200 burst is
      // >5x the worst second ever recorded on this gateway, so nothing
      // legitimate — and not even a repeat of that loop — can reach it.
      throttlingRateLimit: 100,
      throttlingBurstLimit: 200,
    };

    // --- Whose 5xx is it? (2026-08-20 sweep finding) -----------------------
    // The API-level `AWS/ApiGateway 5xx` metric counts every 5xx on this
    // gateway, which is SHARED by every tenant site and backend. Over 30 days
    // of alarm history exactly one alarm ever fired for real — the 5xx one, 4
    // times on 2026-08-14 — and it was not us: the 10 requests behind it all
    // carried `int=200` on `…/komlaba/site-stg/…`, i.e. a client's
    // PRE-PRODUCTION site returning 500 on two of its own routes. Nothing of
    // ours had misbehaved. An alarm that cries wolf for someone else's bug is
    // how the only real-time alert this platform has gets ignored, and a
    // genuine failure of ours would have looked exactly the same.
    //
    // The discriminant is already written down in the access log, twice over:
    //   * `integrationStatus = 200` — the integration ANSWERED normally, so the
    //     5xx is the payload it chose to return, not a gateway fault;
    //   * the route key — tenant `…/site…` routes integrate DIRECTLY with the
    //     app's own `app-app-*` Lambda, and they are the only routes carrying
    //     `/site`. Every platform route is `/mcp`, `/mcp-connections`,
    //     `/org-events`, `/billing/…`, `/.well-known/…`, the connector's own
    //     `…/auth/…`, or `/o/{orgId}/{app}/{agent,telegram,secrets,domains,
    //     cron,llm,mail}/…`.
    // BOTH together — and only both — mean "the client's app answered 500".
    // Everything else is ours, including our own handler returning a 500 with
    // `int=200`: filtering on `integrationStatus` alone would have traded a
    // noisy alarm for a blind one.
    //
    // Two filters over the SAME log events, subtracted at the alarm. Deriving
    // both from one stream is deliberate — pairing a log-derived count with the
    // gateway's own metric would let ingestion skew push one hit into the next
    // period and invent a difference out of nothing.
    const httpApi5xxAllFilter = new logs.MetricFilter(
      this,
      "HttpApi5xxAllFilter",
      {
        logGroup: accessLogGroup,
        metricNamespace: "Dilaya/Connector",
        metricName: "HttpApi5xx",
        // Access-log values are JSON *strings* (`"status":"500"`), so this is a
        // wildcard string match — a numeric comparison would match nothing.
        filterPattern: logs.FilterPattern.literal('{ $.status = "5*" }'),
        metricValue: "1",
        // Without a default, a period with no match has no datapoint at all and
        // `total - tenantApp` is DROPPED for that period rather than evaluated
        // — which would silently disarm the alarm below in exactly the case it
        // exists for (a platform 5xx in a period with no tenant 5xx).
        defaultValue: 0,
      }
    );
    // Not alarmed on here, on purpose: a client's own 500 is the client's to
    // fix, and alerting the org that owns the app is its own problem. What this
    // metric does is make that population countable instead of invisible.
    const httpApi5xxTenantAppFilter = new logs.MetricFilter(
      this,
      "HttpApi5xxTenantAppFilter",
      {
        logGroup: accessLogGroup,
        metricNamespace: "Dilaya/Connector",
        metricName: "HttpApi5xxTenantApp",
        filterPattern: logs.FilterPattern.literal(
          '{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }'
        ),
        metricValue: "1",
        defaultValue: 0,
      }
    );

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
    monitoredFunctions.push({ label: "Prm", fn: prmLambda });

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

    // Public domain-purchase route (NO JWT authorizer). The USER opens
    // /o/{orgId}/{app}/domains/register (a signed single-use link minted by
    // register-domain) to enter the registrant contacts out of band; the
    // connector Lambda passes them straight to Route 53 Domains (never into
    // MCP, never stored). STATIC like the other public routes; the handler
    // validates the exact sub-path and answers 404 when the domainPurchase
    // feature is off — the route itself is unconditional, matching the
    // secrets/telegram pattern. Invoke permission is the api-wide
    // HttpApiInvokeAll grant below.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/domains/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public MCP-connection routes (NO JWT authorizer). Two surfaces:
    //   /mcp-connections/{consent,callback} — the org-level OAuth consent flow
    //     for OUTBOUND connections to external MCP servers: `consent` is a
    //     signed single-use link (org rides in the query + HMAC token, no org
    //     path segment) that 302s to the target server's authorization page;
    //     `callback` is the FIXED redirect URI registered via DCR (it must be
    //     stable across orgs, hence top-level). Tokens land in SSM SecureString
    //     /dilaya/<orgId>/mcp/* — see the SSM grant below.
    //   /o/{orgId}/{app}/mcp/{proxy+} — the gateway a per-app backend Lambda
    //     POSTs to to call a GRANTED tool on a connected server. Auth is the
    //     app's DILAYA_CAPABILITY token (HMAC-verified in the connector Lambda,
    //     appId cross-checked against the path), allowlist enforced fail-closed
    //     server-side. STATIC like the other public routes; the handler
    //     validates the exact sub-path. Invoke permission is the api-wide
    //     HttpApiInvokeAll grant below.
    httpApi.addRoutes({
      path: "/mcp-connections/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/mcp/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public app-cron gateway (NO JWT authorizer). A per-app backend Lambda
    // manages ITS OWN schedules (one-shot reminders, recurring jobs) here,
    // authenticated by its DILAYA_CAPABILITY token — same self-auth model as
    // the MCP gateway above. The connector enforces app identity + owns all
    // Scheduler credentials; app Lambdas get NO scheduler IAM.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/cron/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public app-LLM gateway (NO JWT authorizer). A per-app backend Lambda
    // runs completions/embeddings on the platform OpenAI key here (runtime
    // `llm` helper), authenticated by its DILAYA_CAPABILITY token — same
    // self-auth model as the MCP/cron gateways. The connector enforces the
    // per-org opt-in + monthly budget and holds the key; app Lambdas carry
    // NO provider credentials and get no new IAM.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/llm/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public app-mail gateway (NO JWT authorizer). A per-app backend Lambda
    // sends its transactional email here (runtime `mail.send`) instead of
    // calling Postmark itself — same DILAYA_CAPABILITY self-auth as the
    // MCP/cron/LLM gateways. Two reasons it moved: the org's monthly email
    // allowance is enforced connector-side (a cap the app could bypass is not
    // a cap), and the per-app Postmark token stops being something an app
    // Lambda has to read. The old direct path still works, so a Lambda still
    // on the previous runtime layer keeps sending while the layer propagates.
    httpApi.addRoutes({
      path: "/o/{orgId}/{app}/mail/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // Public org-events webhook (NO JWT authorizer). dilaya.eu (the connect
    // AS) POSTs here on each org modification to invalidate the connector's
    // org-info cache for that org. Self-authenticated in the connector: the
    // request carries a short-lived RS256 assertion signed by the AS's own
    // KMS key, verified against the AS JWKS — the same trust root this
    // stack's JWT authorizer uses. The custom domain maps straight to API
    // Gateway (no CloudFront hop), so no header-forwarding concerns.
    httpApi.addRoutes({
      path: "/org-events",
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    // Public domain-billing read (NO JWT authorizer). dilaya.eu pulls an org's
    // REGISTERED domain names and their AWS prices from here, to invoice them
    // at cost + margin — only the connector knows a registration succeeded, and
    // only its AWS account can price a TLD. Same self-authentication as the
    // webhook above (an AS-signed RS256 assertion, verified in the connector
    // against the AS JWKS), with the `aud` bound to THIS url so an org-events
    // assertion cannot be replayed here.
    //
    // A PULL, not a push: a lost push is a domain nobody is ever charged for
    // and nothing says so, whereas a missed read is picked up by the next one.
    httpApi.addRoutes({
      path: "/billing/domain-orders",
      methods: [apigwv2.HttpMethod.GET],
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
            // Un-forgeable variant: the shared secret the app-content distribution
            // stamps as `x-dilaya-origin-verify`. When present the authorizer accepts
            // it (and, transitionally, the legacy marker); empty → marker-only gate.
            appContentOriginSecret: appContentOriginSecret ?? "",
            // Rotation window: the PREVIOUS secret is also accepted while set,
            // so re-stamping the distributions causes no 403 window.
            appContentOriginSecretPrevious: appContentOriginSecretPrevious ?? "",
          },
        }
      );
      frontendAuthorizerRef = frontendAuthorizerFn;
      monitoredFunctions.push({ label: "FrontendAuthorizer", fn: frontendAuthorizerFn });

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
      monitoredFunctions.push({ label: "AuthLambda", fn: authLambdaFn });

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

    // -----------------------------------------------------------------------
    // App crons — EventBridge Scheduler invoking per-app Lambdas DIRECTLY.
    //
    // "Scheduled deterministic work" for apps: the connector creates schedules
    // (recurring cron() or one-shot at(), e.g. booking reminders) in ONE
    // dedicated group, each targeting an app Lambda with a
    // `{ dilayaCron: { name, schema, orgId } }` payload the `hereya` runtime
    // recognizes. Invocation is IAM (Scheduler assumes the invoke role below)
    // — never through the public API, so a cron event cannot be forged from
    // outside. Retry policy is set connector-side and deliberately SHORT
    // (transient-only): a failed business action must fail loudly, not be
    // replayed hours later.
    // -----------------------------------------------------------------------

    const appCronGroup = new scheduler.CfnScheduleGroup(this, "AppCronGroup", {
      name: `${this.stackName}-app-crons`,
    });
    const appCronInvokeRole = new iam.Role(this, "AppCronInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Assumed by EventBridge Scheduler to invoke per-app Lambdas (dilaya app crons).",
    });
    appCronInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [appLambdaArnPattern],
      })
    );
    fn.addEnvironment("APP_CRON_GROUP_NAME", appCronGroup.name!);
    fn.addEnvironment("APP_CRON_INVOKE_ROLE_ARN", appCronInvokeRole.roleArn);
    // Connector manages schedules ONLY inside its own group; the pass-role is
    // pinned to the invoke role AND to the Scheduler service.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/${appCronGroup.name}/*`,
        ],
      })
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:ListSchedules"],
        resources: ["*"],
      })
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [appCronInvokeRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      })
    );

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

    // Per-app log-group retention. A tenant Lambda's log group is created by the
    // RUNTIME on first invocation, not by this stack, so it is born with AWS's
    // "never expire" default while every group declared here gets 731 days —
    // tenant handlers were keeping their users' log lines forever. The connector
    // now creates the group itself and stamps an expiry on it (365 days, matching
    // the 12-month conservation commitment) at create AND at every redeploy, which
    // also back-fills apps provisioned before this shipped. Scoped to the tenant
    // name pattern only: this grant can never touch a platform log group.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:PutRetentionPolicy"],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${appLambdaNamePrefix}*:*`,
        ],
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

    // Multi-tenant only: outbound MCP-connection OAuth tokens live at
    // /dilaya/<orgId>/mcp/<connection>/tokens — deliberately OUTSIDE /apps/* so
    // no per-app Lambda role (own-app /apps/<app>/{mail,secrets}/* only) can
    // ever read them. Only the connector reads/writes/refreshes them.
    const mcpTokensSsmArns = organizationId
      ? []
      : [`arn:aws:ssm:${this.region}:${this.account}:parameter/dilaya/*/mcp/*`];

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ],
        resources: [agentSecretSsmArn, ...mcpTokensSsmArns],
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
    // Per-app state table (DynamoDB, on-demand). It started as cheap
    // "is there something new?" flags so polling loops wouldn't have to query
    // the database — but it grew: it now also holds the agent definitions
    // (`agent#…`: the hand-written prompt, the wake signal, the poll token) and
    // the consumption ledgers billing reads (`usage#…`, `usageorg#…`,
    // `quota#…`, `llmspend#…`, `mailcount#…`), plus the agent inboxes
    // (`notif#…`) and the Telegram bot config. Org-scoped (one table per
    // deployment); items are keyed per app via the partition key.
    //
    // Hence PITR + RETAIN, matching `dilaya/aws-sqlite-data`'s RegistryTable:
    // a bad write, a failed migration or a destroyed stack would otherwise take
    // the prompts and the billing counters with it, with no way back — not even
    // by a minute (no on-demand backup and no AWS Backup plan exists in the
    // account). ~0.13 $/month at the table's current size.
    // -----------------------------------------------------------------------
    const appStateTable = new dynamodb.Table(this, "AppStateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Three distinct protections, each closing a hole the others leave open:
      // PITR restores corrupted CONTENTS of a table that still exists; RETAIN
      // keeps the table when the STACK goes away; deletion protection makes AWS
      // refuse a direct DeleteTable (console, CLI, a stray script) until the
      // flag is cleared in a separate deliberate step. This table carries the
      // agent definitions (hand-written prompts) and the usage counters billing
      // reads, so all three are warranted. Trade-off accepted: retiring this
      // table for real now needs the flag cleared by hand first.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    fn.addEnvironment("APP_STATE_TABLE", appStateTable.tableName);
    appStateTable.grantReadWriteData(fn);

    // Where a platform alarm lands. Set ONLY when both are configured: the
    // connector refuses an alarm envelope rather than defaulting, so a
    // half-configured deploy fails loudly instead of writing nowhere.
    if (alarmInboxOrg !== "" && alarmInboxApp !== "") {
      fn.addEnvironment("ALARM_INBOX_ORG", alarmInboxOrg);
      fn.addEnvironment("ALARM_INBOX_APP", alarmInboxApp);
    }

    // The frontend authorizer reads the per-app agent-session HMAC secret
    // (`appsecret#<orgId>#<app>`, written by the connector's ensureAppSecret) to
    // validate the `dilaya_agent` browser-testing session cookie. Read-only.
    if (frontendAuthorizerRef) {
      frontendAuthorizerRef.addEnvironment(
        "APP_STATE_TABLE",
        appStateTable.tableName
      );
      appStateTable.grantReadData(frontendAuthorizerRef);

      // ...and writes exactly ONE kind of row: the per-app monthly request
      // counter it increments on every attributed request (`reqcount#<orgId>#
      // <app>#<month>`, read back by get-usage-report).
      //
      // Deliberately NOT grantReadWriteData. This authorizer is the most
      // exposed component in the stack — it is invoked by every anonymous
      // request that reaches a tenant frontend — and the same table holds the
      // per-app agent-session secrets, the quota measurement cache and the LLM
      // spend ledger. A blanket write grant would put all of those inside the
      // blast radius of the one Lambda every stranger can reach, to add a
      // counter. `dynamodb:LeadingKeys` pins the grant to the partition keys it
      // actually needs, so the worst a compromise of this function could do to
      // the table is miscount requests.
      // The rate guard's two knobs. Both have working defaults in the
      // authorizer, so an older deployment behaves identically; these exist so
      // the limit can be retuned — and blocking switched on — by redeploying
      // rather than by editing the handler.
      frontendAuthorizerRef.addEnvironment(
        "FRONTEND_RATE_LIMIT",
        frontendRateLimit
      );
      frontendAuthorizerRef.addEnvironment(
        "FRONTEND_RATE_BLOCK",
        frontendRateBlock
      );

      frontendAuthorizerRef.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:UpdateItem"],
          resources: [appStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              // Two row families, both counters: the monthly consumption count
              // and the per-IP-per-minute rate guard. Still nothing else on
              // this table.
              // Three counter families now: the per-app monthly count, the
              // per-IP-per-minute rate guard, and the per-ORG monthly count
              // that the plan's request cap is enforced against. Still nothing
              // else on this table.
              "dynamodb:LeadingKeys": [
                "reqcount#*",
                "ratecount#*",
                "reqcountorg#*",
              ],
            },
          },
        })
      );
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

        // Host map = DATA, not code (2026-07-19): a CloudFront KeyValueStore
        // holds one key per vanity/BYOD host (`<host>` -> `{"o":"<orgId>",
        // "a":"<app>"}`). The connector adds/removes KEYS at provisioning —
        // the function CODE below never carries tenant state, so deploys that
        // change the body can never reset the routing table (the historical
        // `var HOSTMAP = {…};` byte-swap pattern is gone).
        const appHostKvs = new cloudfront.KeyValueStore(this, "AppHostKvs", {
          comment: "dilaya vanity/BYOD host -> {o,a} routing table",
        });

        // -------------------------------------------------------------------
        // Edge-served static assets + opt-in origin caching (2026-07-19).
        //
        // 1. A dedicated static-assets bucket: the connector extracts an app
        //    zip's `assets/` files to `_appstatic/<orgId>/<appName>/...` at
        //    deploy-backend time; the "/static/*" behavior below serves them
        //    straight from S3 (OAC) — no Lambda in the path. Static-MODE apps
        //    (phase 3) additionally keep their whole site bundle under
        //    `_appsite/<orgId>/<appName>/...` in the SAME bucket — the router
        //    function swaps the origin to S3 for those hosts.
        // 2. The default behavior's cache policy respects the ORIGIN's
        //    Cache-Control (opt-in per response; ttl 0 when absent, so every
        //    current response stays uncached). The frontend session cookies are
        //    part of the cache key, so an authenticated response can only ever
        //    be cached under that user's own cookie — never served cross-user.
        //
        // (Defined BEFORE the router function: its code interpolates the
        // bucket's regional domain for the static-mode origin switch.)
        // -------------------------------------------------------------------
        const staticAssetsBucket = new s3.Bucket(this, "AppStaticAssetsBucket", {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
        });
        // Runtime-created BYOD per-org distributions reference this same bucket
        // + OAC (by id, via the envs below): allow ANY distribution of this
        // account to read — CloudFront only presents a SourceArn for distros it
        // actually serves, so this stays account-scoped.
        staticAssetsBucket.addToResourcePolicy(
          new iam.PolicyStatement({
            actions: ["s3:GetObject"],
            resources: [staticAssetsBucket.arnForObjects("*")],
            principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
            conditions: {
              StringLike: {
                "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/*`,
              },
            },
          })
        );
        const staticAssetsOac = new cloudfront.S3OriginAccessControl(
          this,
          "AppStaticAssetsOac"
        );
        const staticAssetsOrigin =
          origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket, {
            originAccessControl: staticAssetsOac,
          });

        // Viewer-request CloudFront Function (JS 2.0 for the KVS binding).
        const appHostRouterFn = new cloudfront.Function(this, "AppHostRouter", {
          functionName: `${appLambdaNamePrefix}apphost-router`,
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          keyValueStore: appHostKvs,
          code: cloudfront.FunctionCode.fromInline(`import cf from 'cloudfront';
const kvs = cf.kvs();
async function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var e;
  try {
    // NOTE: the JS 2.0 runtime rejects \`await\` inside a call ARGUMENT
    // ("await in arguments not supported") — hoist it (prod 503, 2026-07-19).
    var raw = await kvs.get(host);        // unknown host -> throws
    e = JSON.parse(raw);
  } catch (err) {
    return request;                       // passthrough -> origin 404
  }
  // CANONICAL REDIRECT (value flag r = target host): the host 301s to the same
  // path+query on r instead of serving the app — rendered entirely at the edge
  // (no Lambda), identical in static and dynamic modes. Set via
  // set-custom-domain({ redirect_to }); the connector guarantees r is a host of
  // the same app and never itself a redirect (no chains).
  if (e.r) {
    var loc = 'https://' + e.r + request.uri;
    var qs = request.querystring;
    var parts = [];
    for (var k in qs) {
      if (qs[k].multiValue) {
        for (var j = 0; j < qs[k].multiValue.length; j++) parts.push(k + '=' + qs[k].multiValue[j].value);
      } else {
        parts.push(k + '=' + qs[k].value);
      }
    }
    if (parts.length) loc += '?' + parts.join('&');
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        'location': { value: loc },
        'cache-control': { value: 'public, max-age=3600' }
      }
    };
  }
  var uri = request.uri;                  // e.g. "/e/foo" or "/auth/login" or "/"
  // STAGING (value flag e = 's', deploy-pkg >= 0.1.30): this host serves the
  // app's staging deployment — same app, same data, candidate CODE. Its S3
  // folders carry a '--stg' suffix (app names never contain '-', so no
  // collision) and its dynamic origin routes to /site-stg. /auth/* stays
  // SHARED with production (auth is app-level; one login works on both hosts).
  var a = e.a;
  var siteSeg = '/site';
  if (e.e === 's') { a = e.a + '--stg'; siteSeg = '/site-stg'; }
  // /static/* is served straight from the static-assets S3 origin (the
  // "/static/*" cache behavior matches on the VIEWER uri, then this rewrite
  // maps it to the tenant's key prefix): "/static/x" -> "/_appstatic/<org>/<app>/x"
  if (uri === '/static' || uri.indexOf('/static/') === 0) {
    request.uri = '/_appstatic/' + e.o + '/' + a + uri.slice(7);
    return request;
  }
  // STATIC sections (value flag p = URI prefix list, phase 3 hybrid): paths
  // under a declared prefix serve the app's pre-built site bundle from the
  // static bucket (/_appsite/<org>/<app>/..., OAC-signed origin swap, SPA
  // fallback to the SECTION's index.html). Everything else — ALWAYS including
  // /api/* and /auth/* — stays dynamic on the API-GW origin, so a hybrid app
  // keeps its Lambda pages and its login flow. p:["/"] = whole-site static.
  if (e.p && e.p.length && uri !== '/api' && uri.indexOf('/api/') !== 0
      && uri !== '/auth' && uri.indexOf('/auth/') !== 0) {
    var m = null;
    for (var i = 0; i < e.p.length; i++) {
      var pf = e.p[i];
      if (pf === '/' || uri === pf || uri.indexOf(pf + '/') === 0) {
        if (m === null || pf.length > m.length) m = pf;   // longest prefix wins
      }
    }
    if (m !== null) {
      var last = uri.split('/').pop();
      var file;
      if (last.indexOf('.') >= 0) {
        file = uri;                                       // real file — exact key
      } else {
        // FILE-FIRST resolution (deploy-pkg >= 0.1.34): a multi-page bundle
        // (Astro/Hugo/Next export) has site/<path>/index.html per page. The
        // connector writes one KVS route key per such page at deploy time
        // ('r|<org>|<folder>|<path>' -> '1', folder = app or app--stg), so the
        // edge can serve the PAGE's index.html instead of the section's. Miss
        // (no key, or a pre-route connector) -> the SPA fallback below, byte-
        // identical to the historical behavior.
        file = (m === '/' ? '' : m) + '/index.html';      // SPA fallback (section index)
        var norm = uri.length > 1 && uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
        if (norm !== '/' && norm !== m) {
          try {
            // JS 2.0: await must be a plain statement (never in an argument).
            var hit = await kvs.get('r|' + e.o + '|' + a + '|' + norm);
            if (hit) file = norm + '/index.html';
          } catch (miss) {
            // no such route -> keep the section fallback
          }
        }
      }
      request.uri = '/_appsite/' + e.o + '/' + a + file;
      cf.updateRequestOrigin({
        "domainName": "${staticAssetsBucket.bucketRegionalDomainName}",
        "originAccessControlConfig": {
          "enabled": true,
          "signingBehavior": "always",
          "signingProtocol": "sigv4",
          "originType": "s3"
        },
        // Reset the API-GW origin's custom headers (x-dilaya-origin-verify):
        // unspecified settings are INHERITED from the assigned origin, and
        // S3+OAC must see none of them.
        "customHeaders": {}
      });
      return request;
    }
  }
  // auth routes live at /o/<org>/<app>/auth/... ; everything else at
  // /o/<org>/<app>/site/... (production) or .../site-stg/... (staging).
  var prefix = uri === '/auth' || uri.indexOf('/auth/') === 0
      ? '/o/' + e.o + '/' + e.a
      : '/o/' + e.o + '/' + e.a + siteSeg;
  request.uri = prefix + uri;             // "/o/<org>/<app>/site/e/foo"
  request.headers['x-dilaya-app-host'] = { value: host };  // carry viewer host to origin
  return request;
}`),
        });

        const appContentCachePolicy = new cloudfront.CachePolicy(
          this,
          "AppContentCachePolicy",
          {
            comment:
              "Respect origin Cache-Control (opt-in); session cookies in the cache key",
            minTtl: cdk.Duration.seconds(0),
            defaultTtl: cdk.Duration.seconds(0),
            maxTtl: cdk.Duration.days(365),
            cookieBehavior: cloudfront.CacheCookieBehavior.allowList(
              "dilaya_id_token",
              "hereya_id_token",
              "dilaya_agent"
            ),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
          }
        );

        // The origin-request policy is SHARED with the runtime-created BYOD
        // per-org distributions (the connector references it by id via
        // APP_CONTENT_ORIGIN_REQUEST_POLICY_ID), so it is hoisted out of the
        // distribution literal.
        const appContentOriginPolicy = new cloudfront.OriginRequestPolicy(
          this,
          "AppContentOriginPolicy",
          {
            // The frontend session cookies the auth Lambda sets +
            // the frontend authorizer reads (dilaya_* current, hereya_id_token
            // legacy). CloudFront strips any cookie not listed.
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList(
              "dilaya_id_token",
              "hereya_id_token",
              "dilaya_agent"
            ),
            // Base forwarded set + `x-dilaya-app-host` (added to
            // frontendForwardHeaders above when appContentDomain is set).
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
              ...frontendForwardHeaders
            ),
            queryStringBehavior:
              cloudfront.OriginRequestQueryStringBehavior.all(),
          }
        );

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
                // Un-forgeable origin lock: stamp the shared secret on every
                // edge->origin request. Only this distribution knows it, so a
                // direct app.dilaya.eu hit (no CloudFront) can't reproduce it.
                // Added only when the secret is configured (else feature-off).
                ...(appContentOriginSecret
                  ? {
                      customHeaders: {
                        "x-dilaya-origin-verify": appContentOriginSecret,
                      },
                    }
                  : {}),
              }),
              viewerProtocolPolicy:
                cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: appContentCachePolicy,
              originRequestPolicy: appContentOriginPolicy,
              functionAssociations: [
                {
                  function: appHostRouterFn,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            },
            additionalBehaviors: {
              // Matched on the VIEWER uri; the router function (attached here
              // too) rewrites /static/* -> /_appstatic/<org>/<app>/* so each
              // tenant's assets resolve under its own S3 key prefix.
              "/static/*": {
                origin: staticAssetsOrigin,
                viewerProtocolPolicy:
                  cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                functionAssociations: [
                  {
                    function: appHostRouterFn,
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                  },
                ],
              },
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
        // --- BYOD (customer-owned custom domains): the connector lazily creates
        //     ONE standard CloudFront distribution per org at first
        //     set-custom-domain, replicating the app-content behavior — same
        //     API-GW origin + origin-verify secret, the SAME apphost-router
        //     function, and the SAME origin-request policy (referenced by id).
        fn.addEnvironment(
          "APP_CONTENT_ORIGIN_REQUEST_POLICY_ID",
          appContentOriginPolicy.originRequestPolicyId
        );
        // --- Edge static assets + opt-in caching: the connector extracts app
        //     assets/ into the static bucket at deploy-backend, and BYOD
        //     runtime-created distributions replicate the same cache policy +
        //     static origin/behavior (referenced by id).
        fn.addEnvironment("APP_STATIC_BUCKET", staticAssetsBucket.bucketName);
        fn.addEnvironment(
          "APP_STATIC_BUCKET_DOMAIN",
          staticAssetsBucket.bucketRegionalDomainName
        );
        fn.addEnvironment(
          "APP_STATIC_OAC_ID",
          staticAssetsOac.originAccessControlId
        );
        fn.addEnvironment(
          "APP_CONTENT_CACHE_POLICY_ID",
          appContentCachePolicy.cachePolicyId
        );
        staticAssetsBucket.grantReadWrite(fn);
        // --- Host-map KVS: the connector syncs KEYS (data plane) instead of
        //     rewriting function code. DescribeKeyValueStore is the ETag
        //     source every UpdateKeys call must present.
        fn.addEnvironment("APP_HOST_KVS_ARN", appHostKvs.keyValueStoreArn);
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "cloudfront-keyvaluestore:DescribeKeyValueStore",
              "cloudfront-keyvaluestore:ListKeys",
              "cloudfront-keyvaluestore:GetKey",
              "cloudfront-keyvaluestore:PutKey",
              "cloudfront-keyvaluestore:DeleteKey",
              "cloudfront-keyvaluestore:UpdateKeys",
            ],
            resources: [appHostKvs.keyValueStoreArn],
          })
        );
        fn.addEnvironment(
          "APP_CONTENT_CF_FUNCTION_ARN",
          appHostRouterFn.functionArn
        );
        if (appContentOriginSecret) {
          fn.addEnvironment(
            "APP_CONTENT_ORIGIN_SECRET",
            appContentOriginSecret
          );
        }
        // --- Sender-domain scheme on the content domain: per-app Postmark
        //     senders live at `<app>--<orgslug>.<appContentDomain>` (matching
        //     the vanity host), with DKIM/return-path records in the content
        //     zone — the first-party connector domain carries no tenant mail.
        //     The connector needs the zone id + record rights on that zone.
        fn.addEnvironment("APP_CONTENT_ZONE_ID", appContentZoneId);
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "route53:ChangeResourceRecordSets",
              "route53:ListResourceRecordSets",
              "route53:GetHostedZone",
            ],
            resources: [`arn:aws:route53:::hostedzone/${appContentZoneId}`],
          })
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

        // --- IAM (connector fn role): BYOD per-org distributions + certs.
        //     ABAC on the marker tag `dilaya:byod=1`: anything the connector
        //     creates must carry it (RequestTag condition), and every mutation
        //     is gated on the resource carrying it (ResourceTag condition) — so
        //     the connector can never touch non-BYOD certs/distributions (in
        //     particular NOT the shared app-content distribution). Org
        //     segregation itself is enforced by the connector's authz
        //     chokepoint (same trust model as the Cognito admin grant).
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["acm:RequestCertificate", "acm:AddTagsToCertificate"],
            resources: ["*"],
            conditions: {
              StringEquals: { "aws:RequestTag/dilaya:byod": "1" },
              "ForAllValues:StringEquals": {
                "aws:TagKeys": ["dilaya:byod", "dilaya:orgId"],
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
            // CloudFront viewer certs live in us-east-1 regardless of the
            // stack's region.
            resources: [`arn:aws:acm:us-east-1:${this.account}:certificate/*`],
            conditions: {
              StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
            },
          })
        );
        // NOTE: the CreateDistributionWithTags API authorizes against the
        // cloudfront:CreateDistribution action (+ TagResource for the
        // creation-time tags) — there is no CreateDistributionWithTags action.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["cloudfront:CreateDistribution", "cloudfront:TagResource"],
            resources: [
              `arn:aws:cloudfront::${this.account}:distribution/*`,
            ],
            conditions: {
              StringEquals: { "aws:RequestTag/dilaya:byod": "1" },
              "ForAllValues:StringEquals": {
                "aws:TagKeys": ["dilaya:byod", "dilaya:orgId"],
              },
            },
          })
        );
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "cloudfront:GetDistribution",
              "cloudfront:GetDistributionConfig",
              "cloudfront:UpdateDistribution",
              "cloudfront:TagResource",
              "cloudfront:ListTagsForResource",
              // Live-domain migration: atomically move an alias ONTO the org
              // distribution (cross-account source proven via the `_<alias>`
              // TXT record; the target must already carry a covering cert).
              "cloudfront:AssociateAlias",
              "cloudfront:ListConflictingAliases",
            ],
            resources: [
              `arn:aws:cloudfront::${this.account}:distribution/*`,
            ],
            conditions: {
              StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
            },
          })
        );

        // --- Domain purchase through Dilaya (Route 53 Domains), opt-in via
        //     the `domainPurchase` param. The route53domains API is GLOBAL
        //     (us-east-1) with NO resource-level scoping and NO tag-based
        //     ABAC — the grant is necessarily account-broad, which is why it
        //     sits behind an explicit deploy param on top of the connector's
        //     own per-org gate (option flag + purchase cap + allowed TLDs,
        //     all fail-closed from org-info). Deliberately NOT granted:
        //     TransferDomain*, DeleteDomain, UpdateDomainContact (contact
        //     changes go through a human, not the connector).
        if (domainPurchase) {
          fn.addEnvironment("DOMAIN_PURCHASE_ENABLED", "true");
          fn.addToRolePolicy(
            new iam.PolicyStatement({
              actions: [
                "route53domains:CheckDomainAvailability",
                "route53domains:ListPrices",
                "route53domains:RegisterDomain",
                "route53domains:GetDomainDetail",
                "route53domains:GetOperationDetail",
                "route53domains:ListDomains",
                "route53domains:ListOperations",
                "route53domains:GetContactReachabilityStatus",
                "route53domains:ResendContactReachabilityEmail",
                "route53domains:EnableDomainAutoRenew",
                "route53domains:DisableDomainAutoRenew",
              ],
              resources: ["*"],
            })
          );
          // Each purchased domain lands as a NEW hosted zone in this account —
          // and RegisterDomain creates that zone WITH THE CALLER'S credentials,
          // so the connector needs route53:CreateHostedZone itself (proven by
          // the first live purchase: AccessDenied on exactly that action; the
          // registration is refused BEFORE any charge). The connector then
          // discovers the zone (ListHostedZonesByName) and writes the
          // custom-domain records there itself (managed-zone mode: validation
          // CNAMEs, routing incl. the apex ALIAS, DKIM/return-path). Zones
          // that don't exist at deploy time can't be enumerated, so these
          // grants are wildcard; the connector only ever addresses zones
          // matching its own domainorder# rows.
          fn.addToRolePolicy(
            new iam.PolicyStatement({
              actions: [
                "route53:CreateHostedZone",
                "route53:ListHostedZonesByName",
                // CreateHostedZone returns a change id the service polls.
                "route53:GetChange",
              ],
              resources: ["*"],
            })
          );
          fn.addToRolePolicy(
            new iam.PolicyStatement({
              actions: [
                "route53:ChangeResourceRecordSets",
                "route53:ListResourceRecordSets",
                "route53:GetHostedZone",
              ],
              resources: ["arn:aws:route53:::hostedzone/*"],
            })
          );
        }

        // --- Origin-secret rotation, deploy-time: the per-org BYOD
        //     distributions are runtime-created (CloudFormation doesn't know
        //     them), so a deploy-time Trigger re-stamps their origin-verify
        //     header with the CURRENT secret. Re-fires when the secret changes
        //     (it is part of the trigger fn's env); idempotent otherwise. A
        //     failed re-stamp FAILS THE DEPLOY on purpose. Zero-downtime via
        //     appContentOriginSecretPrevious (dual-accept in the authorizer).
        if (appContentOriginSecret) {
          // Versioned memory of the CURRENT secret: CloudFormation updates this
          // parameter on each rotation, and SSM keeps the version history — the
          // frontend authorizer auto-accepts version N-1 during a grace window
          // after a rotation, so NO manual "previous secret" is ever needed.
          const originSecretParam = new ssmparam.StringParameter(
            this,
            "AppContentOriginSecretParam",
            {
              parameterName: `/dilaya/${cdk.Stack.of(this).stackName}/app-content-origin-secret`,
              stringValue: appContentOriginSecret,
              description:
                "Current app-content origin-lock secret (version history feeds the authorizer's rotation grace window)",
            }
          );
          if (frontendAuthorizerRef) {
            frontendAuthorizerRef.addEnvironment(
              "ORIGIN_SECRET_PARAM",
              originSecretParam.parameterName
            );
            frontendAuthorizerRef.addToRolePolicy(
              new iam.PolicyStatement({
                actions: ["ssm:GetParameter", "ssm:GetParameterHistory"],
                resources: [originSecretParam.parameterArn],
              })
            );
          }

          const restampFn = new triggers.TriggerFunction(
            this,
            "ByodOriginRestamp",
            {
              runtime: lambda.Runtime.NODEJS_22_X,
              handler: "index.handler",
              code: lambda.Code.fromAsset(
                path.join(__dirname, "byod-origin-restamp")
              ),
              timeout: cdk.Duration.minutes(5),
              environment: { ORIGIN_SECRET: appContentOriginSecret },
            }
          );
          restampFn.addToRolePolicy(
            new iam.PolicyStatement({
              actions: ["tag:GetResources"],
              resources: ["*"],
            })
          );
          restampFn.addToRolePolicy(
            new iam.PolicyStatement({
              actions: [
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:UpdateDistribution",
              ],
              resources: [
                `arn:aws:cloudfront::${this.account}:distribution/*`,
              ],
              conditions: {
                StringEquals: { "aws:ResourceTag/dilaya:byod": "1" },
              },
            })
          );
        }

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

    // --- Core alarms -------------------------------------------------------
    // Deliberately OUTSIDE the customDomain branch: whether the connector is
    // reached by vanity domain or by raw API endpoint has nothing to do with
    // whether its failures are noticed.
    //
    // Until 2026-08-08 this account held FIVE alarms in total — four on the two
    // database VMs and the capability one — so nothing whatsoever watched
    // `AWS/Lambda Errors`, `AWS/ApiGateway 5xx` or DynamoDB. Every instrument in
    // the sweep recipe was read by hand, twice a day: the 10 gateway 5xx of
    // 2026-08-05 and the 17 % CloudFront 5xx on *.dilaya-apps.eu both sat
    // through two consecutive "prod entirely clean" sweeps before anyone saw
    // them. These alarms close the ~12 h window between sweeps.
    //
    // Thresholds are calibrated on the measured baseline, not guessed: Lambda
    // `Errors` and `Throttles` have been flat 0 since 2026-08-03, and gateway
    // `5xx` 0 since 2026-08-05 21:03Z with the landing API as a control at 0
    // over 7 days. Against an empirically zero floor, ">= 1 in 5 minutes" is
    // not noisy — it is the smallest signal that means something happened.
    for (const { label, fn: monitored } of monitoredFunctions) {
      for (const [metricName, metric] of [
        ["Errors", monitored.metricErrors()],
        ["Throttles", monitored.metricThrottles()],
      ] as const) {
        alertOn(
          new cloudwatch.Alarm(this, `${label}${metricName}Alarm`, {
            metric: metric.with({
              period: cdk.Duration.minutes(5),
              statistic: "Sum",
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator:
              cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            // A function with no traffic reports no datapoint; that is silence,
            // not failure. BREACHING here would page on every quiet night.
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: `Dilaya connector: ${label} Lambda ${metricName} >= 1 in 5 min (baseline is 0).`,
          })
        );
      }
    }

    // --- Volume, which every alarm above is structurally blind to ----------
    // Every instrument in this stack counts FAILURES. On 2026-08-27 a single
    // browser called one tenant route 17 386 times in under two hours — 10 to
    // 19 requests per second, sustained, from one residential IP — and not one
    // of them fired, because every single request answered HTTP 200. A runaway
    // `setInterval` (or a re-triggering effect) in a tenant's own page is not
    // an error anywhere: Lambda `Errors` 0, gateway 5xx 0, CloudFront
    // `5xxErrorRate` 0 %, the databases VM heartbeat a flat 60/60. That one
    // page produced ~70 % of the connector's traffic for the day, and the
    // only witness was the invocation COUNT — a number nobody reads between
    // two sweeps. Without the sweep it would have been discovered on the bill.
    //
    // The frontend authorizer is the right place to watch, for two reasons.
    // It is on the path of every tenant site/auth request (`authorizerResult
    // TtlInSeconds: 0` — no caching, so one invocation per request, no
    // undercount), and that path is the only UNBOUNDED one: it is public
    // browser traffic. Everything else here is driven by agents or crons,
    // whose rate we set ourselves.
    //
    // The threshold is calibrated on the measured baseline, like the alarms
    // above, but the arithmetic runs the other way — this one must sit far
    // ENOUGH ABOVE normal to never cry wolf, while still catching a loop
    // early. Background is 2–190 invocations/hour; the 2026-08-27 loop ran at
    // ~36 000/hour. 3 000/hour is ~16x the busiest legitimate hour ever
    // measured and ~1/12th of the loop — a real traffic spike (a tenant's
    // launch day, a newsletter) has room to be twelve times the record before
    // it says anything, and a runaway crosses it within the first few minutes.
    //
    // The period is an hour on purpose. This is a COST alarm, not an outage
    // one: nothing is broken, nothing is down, and the question it answers —
    // "is someone burning money right now?" — does not get a better answer
    // for being asked every five minutes. An hourly window also refuses to
    // fire on a legitimate short burst, which a 5-minute window at the
    // equivalent rate would do regularly.
    if (frontendAuthorizerRef) {
      alertOn(
        new cloudwatch.Alarm(this, "FrontendAuthorizerVolumeAlarm", {
          metric: frontendAuthorizerRef.metricInvocations({
            period: cdk.Duration.hours(1),
            statistic: "Sum",
          }),
          threshold: 3000,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          // Same reasoning as the Errors alarms: no traffic is silence.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            "Dilaya connector: FrontendAuthorizer invocations >= 3000 in 1 hour (baseline 2-190/h). " +
            "This is a VOLUME alarm, not a failure one — everything is probably answering 200. It " +
            "means one tenant frontend is calling far more than any page legitimately does, almost " +
            "always a loop in the app's own code (a setInterval without a guard, or an effect that " +
            "re-triggers itself). Find it in the HttpApiAccessLogs group: group the last hour by " +
            "sourceIp and path — a loop is ONE ip on ONE path, which is what separates it from a " +
            "scanner (many paths, 404s) or real popularity (many ips). The org and app are in the " +
            "path (/o/{orgId}/{app}/...); tell that app's owner, since the fix is in their page.",
        })
      );
    }

    // --- What the rate guard WOULD have refused ---------------------------
    // The guard ships in COUNT mode (see the authorizer's checkRate): it logs
    // one `rate_guard` line per offending request and refuses nothing. That
    // makes this filter the ONLY way to know it is doing anything at all — a
    // component that RUNS without DELIVERING is invisible to every instrument
    // that counts executions, which is exactly how the alarm relay sat broken
    // for two real firings (t_e95d603a0a32).
    //
    // The same line, and therefore this same alarm, keeps working when blocking
    // is switched on: `blocked` inside the line says which happened, so nothing
    // here has to change on the day the mode flips.
    //
    // Substring-free JSON pattern, and deliberately NO dimensions: CloudWatch
    // refuses a metric filter carrying both `dimensions` and a `defaultValue`,
    // and refuses dimensions altogether on a pattern that does not extract
    // named fields — two rules a green `cdk synth` does not enforce and that
    // cost a rolled-back production deploy on 2026-08-27.
    if (frontendAuthorizerRef) {
      const rateGuardFilter = new logs.MetricFilter(this, "RateGuardFilter", {
        logGroup: frontendAuthorizerRef.logGroup,
        metricNamespace: "Dilaya/Connector",
        metricName: "RateGuardTripped",
        filterPattern: logs.FilterPattern.literal('{ $.type = "rate_guard" }'),
        metricValue: "1",
      });
      alertOn(
        new cloudwatch.Alarm(this, "RateGuardAlarm", {
          metric: rateGuardFilter.metric({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            "Dilaya connector: a tenant frontend crossed the per-IP rate guard (default 1000 requests " +
            "per minute per IP) in the last 5 min. While FRONTEND_RATE_BLOCK is false this refused " +
            "NOTHING — it reports what a block WOULD have cut, which is the data needed before " +
            "turning blocking on. Read the `rate_guard` lines in the FrontendAuthorizer log group: " +
            "`blocked` says whether it was enforced, `hits` how far over, `app`/`org` who, and `ip` " +
            "is a truncated hash (the same tag across a minute = the same address). One hashed ip " +
            "far over the limit on one path is a runaway loop in that app's page; several distinct " +
            "tags near the limit is more likely a shared address (corporate NAT, mobile carrier) — " +
            "which is the case that must NOT be blocked.",
        })
      );
    }

    // --- A customer was CUT --------------------------------------------
    // The heaviest action this platform takes: an organization past its
    // monthly request allowance stops being served until the 1st of the next
    // month. It is deliberate (Jonatan, 2026-08-28: unbounded exposure is
    // worse than a bounded outage, and it is his exposure) — but it must never
    // be something we learn about from the customer.
    //
    // The line it counts is written only when a request is actually refused,
    // so this alarm firing means a real site is dark right now.
    if (frontendAuthorizerRef) {
      const requestCapFilter = new logs.MetricFilter(this, "RequestCapFilter", {
        logGroup: frontendAuthorizerRef.logGroup,
        metricNamespace: "Dilaya/Connector",
        metricName: "RequestCapCut",
        filterPattern: logs.FilterPattern.literal('{ $.type = "request_cap" }'),
        metricValue: "1",
      });
      alertOn(
        new cloudwatch.Alarm(this, "RequestCapAlarm", {
          metric: requestCapFilter.metric({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            "Dilaya: an organization has been CUT for exceeding its monthly request allowance — " +
            "its site is returning 403 and will keep doing so until the 1st of next month. This is " +
            "not a fault, it is the cap doing its job, but it needs a human the same day: read the " +
            "`request_cap` lines in the FrontendAuthorizer log group for the org, the count and the " +
            "cap. Either the customer should move up a plan, or their allowance should be raised " +
            "from the admin page — which takes effect within a minute (the authorizer caches the " +
            "cap for 60s). If this fires without a warning having gone out first, the projection " +
            "half of the feature is what failed, not this one.",
        })
      );
    }

    // The gateway layer, which `AWS/Lambda Errors` structurally cannot see: a
    // 502 malformed response, a refused integration or a 504 integration
    // timeout never makes the Lambda throw. That blind spot is what hid 20 5xx
    // over 7 days until the access log shipped on 2026-08-07.
    //
    // Scoped to OUR 5xx by subtracting the tenant-app population (see the two
    // metric filters on the access log, above). A tenant timing out or refusing
    // its integration still counts as ours — `int != 200` means the gateway
    // could not get a normal answer, and that is a platform question until
    // proven otherwise.
    alertOn(
      new cloudwatch.Alarm(this, "HttpApiPlatform5xxAlarm", {
        metric: new cloudwatch.MathExpression({
          expression: "total - tenantApp",
          usingMetrics: {
            total: httpApi5xxAllFilter.metric({
              period: cdk.Duration.minutes(5),
              statistic: "Sum",
            }),
            tenantApp: httpApi5xxTenantAppFilter.metric({
              period: cdk.Duration.minutes(5),
              statistic: "Sum",
            }),
          },
          period: cdk.Duration.minutes(5),
          label: "Gateway 5xx that are ours",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Dilaya connector: platform-origin API Gateway 5xx >= 1 in 5 min (a tenant app answering " +
          "500 on its own /site route is excluded — see HttpApi5xxTenantApp). Read the " +
          "HttpApiAccessLogs group: integrationStatus '-' means the request never reached the " +
          "integration (authorizer or gateway refusal); a populated integrationErrorMessage is what " +
          "separates a 502 from a 504; integrationStatus 200 on a platform route means our own " +
          "handler chose to return that 5xx.",
      })
    );

    // 4xx is deliberately NOT alarmed: it runs 30–85/day of pure scanner noise
    // absorbed by tenant apps (all `int=200`). Alarming it would train everyone
    // to ignore this topic, which is how the alarm layer dies a second time.

    // DynamoDB, blind in yet another direction: a throttled or failed state
    // write is not a Lambda error and never reaches the gateway either.
    for (const metricName of ["SystemErrors", "ThrottledRequests"] as const) {
      alertOn(
        new cloudwatch.Alarm(this, `AppState${metricName}Alarm`, {
          metric: new cloudwatch.Metric({
            namespace: "AWS/DynamoDB",
            metricName,
            dimensionsMap: { TableName: appStateTable.tableName },
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: `Dilaya connector: AppStateTable ${metricName} >= 1 in 5 min (baseline is 0).`,
        })
      );
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
