#!/usr/bin/env node
// The region router's Lambda@Edge, as its own us-east-1 app (lib/stack/region-router/edge-stack.ts).
// NOT what hereya deploys (cdk.json points at the pod stack): it has no deploy path yet.
import * as cdk from "aws-cdk-lib/core";
import { parseOrigins } from "../lib/stack/region-router/config";
import { RegionRouterEdgeStack } from "../lib/stack/region-router/edge-stack";

const origins = parseOrigins(process.env.regionRouterOrigins ?? "", []);
const app = new cdk.App();
new RegionRouterEdgeStack(app, process.env.STACK_NAME!, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  origins,
  home: Object.keys(origins)[0],
});
