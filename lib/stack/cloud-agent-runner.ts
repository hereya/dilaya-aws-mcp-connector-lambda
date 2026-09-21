import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import type { StackContext } from "./context";

/** One run is capped at ~12 min by the connector (HARNESS_TIMEOUT_SECONDS); the
 *  Lambda gets the platform maximum so it is never the one that cuts a run. */
export const RUNNER_TIMEOUT_SECONDS = 900;

// -----------------------------------------------------------------------
// Cloud-agent RUNNER: the connector's SAME bundle under a second entry point
// (`handler.runnerHandler`). One invocation = one run of one cloud agent, which
// outlives the ~30 s an API Gateway request gets. It has NO route and NO event
// source: it is invoked asynchronously, by IAM only — by the connector (a
// backend's `agent.run`) and by EventBridge Scheduler (the agent's schedule).
//
// Same ROLE as the connector on purpose — it reads the same agent item, the
// same SSM token path, and the AgentCore grants arrive on that role from the
// dilaya/aws-agentcore-harness package. Its ENVIRONMENT is its own and small:
// what a run reads, and no secret (it never calls resolveSecrets).
// -----------------------------------------------------------------------
export function createCloudAgentRunner(stack: cdk.Stack, ctx: StackContext): void {
  const { appCronInvokeRole, appStateTable, fn, handlerName, hereyaProjectRootDir, oauthServerUrl, plainEnv } = ctx;

  const runner = new lambda.Function(stack, "CloudAgentRunner", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: handlerName.replace(/\.[^.]+$/, ".runnerHandler"),
    code: lambda.Code.fromAsset(path.join(hereyaProjectRootDir, "dist")),
    memorySize: 512,
    timeout: cdk.Duration.seconds(RUNNER_TIMEOUT_SECONDS),
    role: fn.role,
    // A thrown async invocation would be retried — and a retried run is a SECOND
    // run, billed and acting twice. The handler never throws; this is the belt.
    retryAttempts: 0,
    environment: {
      ...plainEnv,
      awsRegion: stack.region,
      APP_STATE_TABLE: appStateTable.tableName,
      // Where the agent's token is refreshed — the AS this deployment authenticates against.
      OAUTH_SERVER_URL: oauthServerUrl,
    },
  });

  fn.addEnvironment("CLOUD_AGENT_RUNNER_FUNCTION", runner.functionName);
  // The role is shared, so this statement is what lets the CONNECTOR start a run.
  // In a policy of its OWN, not the role's default one: the runner depends on its
  // role and that role's default policy, so a statement naming the runner's ARN
  // in there would be a dependency cycle.
  new iam.Policy(stack, "InvokeCloudAgentRunner", {
    roles: [fn.role!],
    statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [runner.functionArn] })],
  });
  // A cloud agent's SCHEDULE is an EventBridge schedule in the app-crons group
  // whose target is the runner itself (connector: cloud-agent/schedule.ts). The
  // role Scheduler assumes could only invoke per-app Lambdas until now.
  appCronInvokeRole.addToPolicy(
    new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [runner.functionArn] })
  );
  ctx.monitoredFunctions.push({ label: "CloudAgentRunner", fn: runner });
}
