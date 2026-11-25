import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as path from "path";
import type { StackContext } from "./context";

/**
 * The integrated dev agent's WORKER — the Lambda that runs an agent turn for a
 * console message, fed by a FIFO queue (message group = one app, so one run
 * per app at a time; a run longer than one invocation re-enqueues itself).
 *
 *   devAgentWorker absent, "" or "false" → NOTHING is created: the template is
 *     byte-identical (no queue, no function, no role statement on the connector).
 *   "true"  → queue + DLQ + worker + event source mapping + two alarms, and ONE
 *     statement appended to the connector role: sqs:SendMessage on the queue.
 *   anything else → the synth FAILS (a typo must not deploy as "off").
 *
 * ⚠️ TURN IT ON ONLY ONCE THE CONNECTOR BUNDLE SHIPS `dev-agent-handler.handler`.
 * The worker runs from the SAME `dist` asset as the connector, with that entry.
 * Before the entry exists the function deploys fine and stays idle — nothing
 * invokes it until a message is queued — but every queued message would fail
 * (Runtime.HandlerNotFound), retry three times and land in the DLQ (its alarm).
 *
 * THE QUEUE NAME IS FIXED, per account and region: the connector derives the
 * URL itself — https://sqs.<region>.amazonaws.com/<account>/dilaya-dev-agent.fifo
 * (region from AWS_REGION, account from its own invoked function ARN) — so its
 * environment, capped at 4 KB, gains nothing. Consequence, on purpose: two
 * stacks with the worker on in one account+region collide at deploy, loudly.
 *
 * The connector side expects, when it starts enqueueing: sqs:SendMessage on
 * that ARN (granted here, nothing else), MessageGroupId = "<orgId>#<app>" and
 * an explicit MessageDeduplicationId (content-based dedup is OFF: two identical
 * messages are two runs; the id is the console message id).
 *
 * Kill switches (plan §5): the SSM config under /dilaya/_platform/dev-agent/,
 * the worker's reserved concurrency set to 0 by hand (messages then retry and
 * reach the DLQ), and the model provider's workspace limit.
 */
export const PARAM = "devAgentWorker";
export const DEV_AGENT_QUEUE_NAME = "dilaya-dev-agent.fifo";
export const DEV_AGENT_DLQ_NAME = "dilaya-dev-agent-dlq.fifo";
export const DEV_AGENT_HANDLER = "dev-agent-handler.handler";
export const DEV_AGENT_SSM_PREFIX = "/dilaya/_platform/dev-agent";
export const WORKER_TIMEOUT = cdk.Duration.seconds(900);
export const WORKER_MEMORY_MB = 1024;
export const MAX_CONCURRENCY = 5;
export const MAX_RECEIVE_COUNT = 3;

/** "true" → on; absent/""/"false" → off; anything else refuses the synth. */
export function devAgentWorkerEnabled(): boolean {
  const value = process.env[PARAM];
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true") throw new Error(`${PARAM}: "${value.slice(0, 40)}" — expected "true" or "false" (absent = false)`);
  return true;
}

export function createDevAgentWorker(stack: cdk.Stack, ctx: StackContext): void {
  if (!devAgentWorkerEnabled()) return;
  const key = ctx.wifKey;
  if (!key) {
    throw new Error(`${PARAM}=true needs the WIF signing key: on a secondary pod, set wifKmsKeyArn too`);
  }

  // DLQ first: 14 days to look at what failed three times.
  const dlq = new sqs.Queue(stack, "DevAgentDlq", {
    queueName: DEV_AGENT_DLQ_NAME,
    fifo: true,
    contentBasedDeduplication: false,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: cdk.Duration.days(14),
  });
  const queue = new sqs.Queue(stack, "DevAgentQueue", {
    queueName: DEV_AGENT_QUEUE_NAME,
    fifo: true,
    contentBasedDeduplication: false,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    // AWS guidance for a Lambda event source: at least 6× the function timeout,
    // so a message is never re-delivered while a (retried) invocation still
    // holds it. 6 × 900 s = 90 min, well under SQS's 12 h maximum.
    visibilityTimeout: cdk.Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
    // A turn nobody started within a day is stale: the human has moved on.
    retentionPeriod: cdk.Duration.days(1),
    deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVE_COUNT },
  });

  const logGroup = new logs.LogGroup(stack, "DevAgentWorkerLogs", {
    retention: logs.RetentionDays.TWO_YEARS, // like every group this stack declares
  });
  const mcpUrl = ctx.customDomain ? `https://${ctx.customDomain}/mcp` : `${ctx.httpApi.apiEndpoint}/mcp`;
  const registryTableName = ctx.plainEnv["registryTableName"];
  const worker = new lambda.Function(stack, "DevAgentWorker", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: DEV_AGENT_HANDLER,
    code: lambda.Code.fromAsset(path.join(ctx.hereyaProjectRootDir, "dist")), // the connector's asset
    memorySize: WORKER_MEMORY_MB,
    timeout: WORKER_TIMEOUT,
    logGroup,
    description: "Dilaya integrated dev agent worker (SQS FIFO, one run per app at a time)",
    // Its OWN environment — never the connector's (4 KB cap there).
    environment: {
      awsRegion: stack.region,
      APP_STATE_TABLE: ctx.appStateTable.tableName,
      ...(registryTableName ? { registryTableName } : {}),
      WIF_KMS_KEY_ID: key.id,
      DEV_AGENT_QUEUE_URL: queue.queueUrl,
      DEV_AGENT_SSM_PREFIX: `${DEV_AGENT_SSM_PREFIX}/`,
      CONNECTOR_MCP_URL: mcpUrl,
    },
  });
  worker.addEventSource(
    new SqsEventSource(queue, {
      batchSize: 1,
      maxConcurrency: MAX_CONCURRENCY,
      reportBatchItemFailures: true,
    })
  );
  grantWorker(stack, ctx, worker, queue, key.arn, registryTableName);

  // The connector enqueues; it may do nothing else with the queue.
  ctx.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["sqs:SendMessage"], resources: [queue.queueArn] }));

  createWorkerAlarms(stack, ctx, worker, dlq);
  new cdk.CfnOutput(stack, "DevAgentQueueUrl", { value: queue.queueUrl });
  new cdk.CfnOutput(stack, "DevAgentQueueArn", { value: queue.queueArn });
  new cdk.CfnOutput(stack, "DevAgentDlqUrl", { value: dlq.queueUrl });
  new cdk.CfnOutput(stack, "DevAgentWorkerName", { value: worker.functionName });
}

function grantWorker(
  stack: cdk.Stack,
  ctx: StackContext,
  worker: lambda.Function,
  queue: sqs.Queue,
  wifKeyArn: string,
  registryTableName: string | undefined
): void {
  // The platform WIF assertion (sub pinned to the platform, plan §4): Sign only.
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:Sign"], resources: [wifKeyArn] }));

  // Platform config, SecureString, under ONE prefix — never a tenant path.
  const ssmBase = `arn:aws:ssm:${stack.region}:${stack.account}:parameter${DEV_AGENT_SSM_PREFIX}`;
  worker.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:GetParameters"], resources: [`${ssmBase}/*`] })
  );
  worker.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["ssm:GetParametersByPath"], resources: [ssmBase, `${ssmBase}/*`] })
  );
  worker.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"], // the AWS-managed SSM key, only through SSM, only for this prefix
      conditions: {
        StringEquals: { "kms:ViaService": `ssm.${stack.region}.amazonaws.com` },
        StringLike: { "kms:EncryptionContext:PARAMETER_ARN": `${ssmBase}/*` },
      },
    })
  );

  // Transcript, lease and spend ledger live in the app state table (plan §3, §5).
  ctx.appStateTable.grantReadWriteData(worker);
  // Registry: read-only, the org/app rows.
  if (registryTableName) {
    const table = `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${registryTableName}`;
    worker.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [table, `${table}/index/*`] })
    );
  }
  // Continuation: a run past its slice re-enqueues itself.
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["sqs:SendMessage"], resources: [queue.queueArn] }));
}

function createWorkerAlarms(stack: cdk.Stack, ctx: StackContext, worker: lambda.Function, dlq: sqs.Queue): void {
  const period = cdk.Duration.minutes(5);
  const common = {
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  };
  ctx.alertOn(
    new cloudwatch.Alarm(stack, "DevAgentDlqDepthAlarm", {
      ...common,
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period, statistic: "Maximum" }),
      alarmDescription: "Dilaya dev agent: a message reached the DLQ (failed 3 times). Baseline is 0.",
    })
  );
  ctx.alertOn(
    new cloudwatch.Alarm(stack, "DevAgentWorkerErrorsAlarm", {
      ...common,
      metric: worker.metricErrors({ period, statistic: "Sum" }),
      alarmDescription: "Dilaya dev agent: DevAgentWorker Lambda Errors >= 1 in 5 min (baseline is 0).",
    })
  );
}
