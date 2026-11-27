import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as crypto from "crypto";
import * as path from "path";

/**
 * The integrated dev agent's SANDBOX computer (POC): a Lambda MicroVMs image — Node 22 + npm +
 * git + headless Chromium + a small control server (lib/sandbox-image/) — that the dev agent
 * WORKER runs one MicroVM of per agent session, for the organizations in `devAgentSandboxOrgs`.
 *
 *   devAgentSandboxOrgs absent or "" → NOTHING changes: no image, no role, no env, no statement.
 *   a comma-separated list of org ids (UUIDs) →
 *     - an AWS::Lambda::MicrovmImage built by the service from the zipped directory (a CDK
 *       asset), with a build role (read that one asset, write its logs) and an execution
 *       role (logs ONLY: the code run inside is the agent's, it gets no AWS access);
 *     - the worker gets DEV_AGENT_SANDBOX_ORGS / _IMAGE_ARN / _EXEC_ROLE_ARN and may run,
 *       inspect, suspend, resume, terminate and mint endpoint tokens for MicroVMs of THAT
 *       image only, pass the managed (AWS-owned) network connectors, and pass the execution
 *       role to Lambda — nothing else;
 *     - nothing changes on the connector function.
 *   anything else fails the synth (a typo must not deploy as "off").
 *
 * Only meaningful with the worker on (devAgentWorker=true). The image build happens during the
 * deploy: a broken image fails (and rolls back) the stack update instead of shipping silently.
 */
export const SANDBOX_PARAM = "devAgentSandboxOrgs";
export const SANDBOX_ENV = "DEV_AGENT_SANDBOX_ORGS";
/** The managed base the Dockerfile's FROM matches (`list-managed-microvm-images`, eu-west-1, 2026-11). */
export const SANDBOX_BASE_IMAGE = "al2023-1";
export const SANDBOX_BASE_VERSION = "4";
export const SANDBOX_MEMORY_MIB = 4096;
export const SANDBOX_HOOK_PORT = 9000;
export const SANDBOX_IMAGE_DIR = path.join(__dirname, "..", "sandbox-image");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sandboxOrgs(): string[] {
  const raw = process.env[SANDBOX_PARAM];
  if (raw === undefined || raw.trim() === "") return [];
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) throw new Error(`${SANDBOX_PARAM}: expected comma-separated org ids (UUIDs)`);
  return ids;
}

/** A MicroVM image name (^[a-zA-Z0-9-_]{1,64}$), stable per stack. */
export function sandboxImageName(stackName: string): string {
  const base = stackName.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
  const h = crypto.createHash("sha256").update(stackName).digest("hex").slice(0, 8);
  return `${base}-devsbx-${h}`;
}

function vmRole(stack: cdk.Stack, id: string, imageName: string): iam.Role {
  return new iam.Role(stack, id, {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", {
      conditions: {
        StringEquals: { "aws:SourceAccount": stack.account },
        ArnLike: { "aws:SourceArn": `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:microvm-image:${imageName}` },
      },
    }),
  });
}

export function attachWorkerSandbox(stack: cdk.Stack, worker: lambda.Function): void {
  const orgs = sandboxOrgs();
  if (orgs.length === 0) return;
  const imageName = sandboxImageName(stack.stackName);
  const logGroup = new logs.LogGroup(stack, "DevAgentSandboxLogs", {
    logGroupName: `/aws/lambda-microvms/${imageName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const asset = new s3assets.Asset(stack, "DevAgentSandboxImageSource", { path: SANDBOX_IMAGE_DIR });

  const buildRole = vmRole(stack, "DevAgentSandboxBuildRole", imageName);
  asset.grantRead(buildRole);
  logGroup.grantWrite(buildRole);
  const execRole = vmRole(stack, "DevAgentSandboxExecRole", imageName);
  logGroup.grantWrite(execRole);

  const image = new lambda.CfnMicrovmImage(stack, "DevAgentSandboxImage", {
    name: imageName,
    description: "Dilaya dev agent sandbox: Node 22, npm, git, headless Chromium, control server",
    baseImageArn: `arn:${stack.partition}:lambda:${stack.region}:aws:microvm-image:${SANDBOX_BASE_IMAGE}`,
    baseImageVersion: SANDBOX_BASE_VERSION,
    buildRoleArn: buildRole.roleArn,
    codeArtifact: { uri: asset.s3ObjectUrl },
    cpuConfigurations: [{ architecture: "ARM_64" }],
    resources: [{ minimumMemoryInMiB: SANDBOX_MEMORY_MIB }],
    // npm install / git clone need the internet: the AWS-managed egress connector, named explicitly.
    egressNetworkConnectors: [`arn:${stack.partition}:lambda:${stack.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`],
    additionalOsCapabilities: [],
    environmentVariables: [],
    logging: { cloudWatch: { logGroup: logGroup.logGroupName } },
    hooks: {
      port: SANDBOX_HOOK_PORT,
      microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 300, validate: "ENABLED", validateTimeoutInSeconds: 60 },
      microvmHooks: {
        run: "ENABLED", runTimeoutInSeconds: 5,
        resume: "ENABLED", resumeTimeoutInSeconds: 5,
        suspend: "ENABLED", suspendTimeoutInSeconds: 10,
        terminate: "ENABLED", terminateTimeoutInSeconds: 5,
      },
    },
  });
  image.node.addDependency(buildRole, logGroup);

  worker.addEnvironment(SANDBOX_ENV, orgs.join(","));
  worker.addEnvironment("DEV_AGENT_SANDBOX_IMAGE_ARN", image.attrImageArn);
  worker.addEnvironment("DEV_AGENT_SANDBOX_EXEC_ROLE_ARN", execRole.roleArn);
  worker.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:SuspendMicrovm", "lambda:ResumeMicrovm", "lambda:TerminateMicrovm", "lambda:CreateMicrovmAuthToken"],
      resources: [image.attrImageArn],
    })
  );
  worker.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["lambda:PassNetworkConnector"],
      resources: [`arn:${stack.partition}:lambda:${stack.region}:aws:network-connector:aws-network-connector:*`],
    })
  );
  worker.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [execRole.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    })
  );
}
