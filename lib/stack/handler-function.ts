import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import type { StackContext } from "./context";

export function createHandlerFunction(stack: cdk.Stack, ctx: StackContext): void {
  const { customDomain, handlerName, hereyaProjectRootDir, memorySize, plainEnv, secretEnvEntries, timeout } = ctx;

  // -----------------------------------------------------------------------
  // Lambda 1: App Handler (Org Lambda — MCP only)
  // -----------------------------------------------------------------------

  // Pass deploy-time config vars to the handler (not in hereyaProjectEnv)
  if (customDomain) {
    plainEnv["customDomain"] = customDomain;
  }

  const fn = new lambda.Function(stack, "Handler", {
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
  ctx.fn = fn;
}