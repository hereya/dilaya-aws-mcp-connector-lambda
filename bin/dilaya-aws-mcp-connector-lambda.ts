#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";

const app = new cdk.App();
new DilayaConnectorLambdaStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
