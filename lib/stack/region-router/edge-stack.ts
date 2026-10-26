import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { edgeHandlerCode } from "./edge-handler";

export interface RegionRouterEdgeStackProps extends cdk.StackProps {
  origins: Record<string, string>;
  home: string;
}

/**
 * The region router's Lambda@Edge, in a stack of its OWN, in us-east-1.
 *
 * Why not inside the pod stack: Lambda@Edge must live in us-east-1 while the pod stack lives in
 * its region, and CDK's `EdgeFunction` answers that with a second, sibling stack in the same app.
 * Hereya's executor runs `cdk deploy` with no stack selector — with two stacks CDK refuses ("Since
 * this app includes more than a single stack…"), and it reads the first `*.template.json` of
 * cdk.out for outputs. So the version is built here and its ARN passed to the pod stack as
 * `regionRouterEdgeVersionArn`, the way the us-east-1 certificates already are. (us-east-1 must
 * be CDK-bootstrapped first; on 26/10/2026 it was not.)
 *
 *   regionRouterOrigins=… STACK_NAME=… npx cdk deploy -a "npx ts-node --prefer-ts-exts bin/region-router-edge.ts"
 */
export class RegionRouterEdgeStack extends cdk.Stack {
  readonly versionArn: string;

  constructor(scope: Construct, id: string, props: RegionRouterEdgeStackProps) {
    super(scope, id, props);
    if (!cdk.Token.isUnresolved(this.region) && this.region !== "us-east-1") {
      throw new Error(`Lambda@Edge must be created in us-east-1, not ${this.region}`);
    }
    const role = new iam.Role(this, "EdgeRole", {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("lambda.amazonaws.com"),
        new iam.ServicePrincipal("edgelambda.amazonaws.com")
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    const code = edgeHandlerCode(props.origins, props.home);
    if (code.length > 4096) throw new Error("region-router edge handler exceeds the 4 096-character inline limit");
    const fn = new lambda.Function(this, "OriginRequest", {
      // Lambda@Edge lags the regional runtimes; 22.x is the newest it is known to accept.
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(code),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      role,
    });
    this.versionArn = fn.currentVersion.functionArn;
    new cdk.CfnOutput(this, "EdgeVersionArn", { value: this.versionArn });
  }
}
