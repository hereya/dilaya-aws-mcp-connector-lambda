import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { StackContext } from "./context";

export function createAppStateTable(stack: cdk.Stack, ctx: StackContext): void {
  const { accessLogGroup, alarmInboxApp, alarmInboxOrg, fn, frontendAuthorizerRef, frontendRateBlock, frontendRateLimit } = ctx;

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
  const appStateTable = new dynamodb.Table(stack, "AppStateTable", {
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
    // Every short-lived row this table holds (the per-IP rate-guard counters,
    // the request counters, the app-creation counters, the channel-event
    // dedupe marks, the one-time setup-token claims, the OAuth state, the
    // locks, the usage days) stamps `expires_at` in epoch SECONDS — and until
    // 0.1.88 nothing ever read it: TTL was never switched on, so the table grew
    // from 259 to 11 760 items in a month, 2 254 of 3 000 sampled being dead
    // `ratecount#` rows (t_appstate_ttl_disabled). Three claim rows
    // (hostmap-sync, domain-watch, cron-suspend-sync) store MILLISECONDS in the
    // same attribute: read as seconds that is year ~58 000, so TTL never
    // touches them — the same eternity they have today, and their own reads
    // compare in ms consistently. Do NOT convert them without migrating the
    // rows: a ms value compared against a seconds clock reads as a claim held
    // for ever, and the sweep behind it stops.
    timeToLiveAttribute: "expires_at",
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

  // The CUSTOMER's half of an alarm (connector src/incident-analysers.ts).
  // When the volume alarm or the tenant-5xx alarm fires, the connector reads
  // the last hour of the access log through Logs Insights, names the org,
  // the app and the path behind it, and hands that org a fiche — in its MCP
  // instructions, its agent inbox, and (via dilaya.eu's usage pull) an email.
  // Read-only, event-driven, and scoped to THIS log group: no timer, no
  // per-app scan, nothing runs unless an alarm already did. `GetQueryResults`
  // takes no resource in IAM (a query id is not an ARN), hence the "*".
  fn.addEnvironment("ACCESS_LOG_GROUP", accessLogGroup.logGroupName);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      // FilterLogEvents (17/09, t_incident_recovery_lag): the app-5xx analyser
      // reads freshly INGESTED lines, which Insights only indexes minutes later.
      actions: ["logs:StartQuery", "logs:StopQuery", "logs:FilterLogEvents"],
      resources: [accessLogGroup.logGroupArn, `${accessLogGroup.logGroupArn}:*`],
    })
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["logs:GetQueryResults"],
      resources: ["*"],
    })
  );

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
    // The long window's three knobs (t_rate_guard_sustained). Same contract:
    // working defaults in the authorizer, retunable — and switchable to
    // blocking — by redeploying rather than by editing the handler.
    frontendAuthorizerRef.addEnvironment(
      "FRONTEND_RATE_WINDOW_LIMIT",
      ctx.frontendRateWindowLimit
    );
    frontendAuthorizerRef.addEnvironment(
      "FRONTEND_RATE_WINDOW_MINUTES",
      ctx.frontendRateWindowMinutes
    );
    frontendAuthorizerRef.addEnvironment(
      "FRONTEND_RATE_WINDOW_BLOCK",
      ctx.frontendRateWindowBlock
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
            // Four counter families now: the per-app monthly count, the
            // per-IP-per-minute rate guard, its long-window twin, and the
            // per-ORG monthly count that the plan's request cap is enforced
            // against. Still nothing else on this table.
            "dynamodb:LeadingKeys": [
              "reqcount#*",
              "ratecount#*",
              "ratewin#*",
              "reqcountorg#*",
            ],
          },
        },
      })
    );
  }
  // The login Lambda counts the codes it sends per address (`otpsend#…`,
  // t_quota_mail_bypass): every send-otp was a Postmark mail with no ceiling, so
  // one allowlisted address could be flooded — and the app's sender reputation
  // with it. Same LeadingKeys discipline as the authorizer: one row family,
  // nothing else on this table (agent secrets, quota cache, LLM ledger).
  if (ctx.authLambdaFn) {
    ctx.authLambdaFn.addEnvironment("APP_STATE_TABLE", appStateTable.tableName);
    ctx.authLambdaFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [appStateTable.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["otpsend#*"] } },
      })
    );
  }
  ctx.appStateTable = appStateTable;
}