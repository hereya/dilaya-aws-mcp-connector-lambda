import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import * as fs from "fs";
import type { StackContext } from "./context";

export function createRuntimeLayer(stack: cdk.Stack, ctx: StackContext): void {
  const { hereyaProjectRootDir } = ctx;

  // -----------------------------------------------------------------------
  // Lambda Layer for per-app runtime utilities
  // -----------------------------------------------------------------------

  // The per-app frontend Lambda runtime layer is only produced by apps that
  // build it (`build:layer`). The lean multi-tenant connector defers web
  // frontends and ships no layer, so create it only when the asset exists.
  const layerDir = path.join(hereyaProjectRootDir, "dist", "layer");
  const runtimeLayer = fs.existsSync(layerDir)
    ? new lambda.LayerVersion(stack, "AppRuntimeLayer", {
        code: lambda.Code.fromAsset(layerDir),
        compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
        description: "Hereya runtime (db, storage) for per-app Lambdas",
      })
    : undefined;
  ctx.runtimeLayer = runtimeLayer;
}