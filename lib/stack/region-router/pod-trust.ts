import * as cdk from "aws-cdk-lib/core";
import type { StackContext } from "../context";
import { POD_SECRET_ENV, REGION_VERIFY_HEADER, VIEWER_HOST_HEADER } from "./config";

/**
 * The POD side of the region router. Behind the front door, API Gateway sees the pod's ORIGIN host
 * (originDomain) in `requestContext.domainName`, so the two things that key on the public host —
 * the plugin-host surface (MCP_DOMAIN: tool list, `POST /`, the 401's resource_metadata) and the
 * PRM's per-host `resource` — need the viewer's host, which the router forwards in
 * x-dilaya-viewer-host.
 *
 * A header anyone can send is not a host anyone may claim: it is honoured ONLY when the same
 * request carries x-dilaya-region-verify equal to the pod's REGION_ROUTER_ORIGIN_SECRET, which only
 * the distribution stamps (an origin custom header overwrites a viewer header of that name).
 * No secret configured → the header is ignored, always. Same idea as the app-content origin lock,
 * but a SEPARATE secret: stamping that one here would open the origin-locked site routes to
 * app.dilaya.eu path traffic.
 *
 * Set on every pod that sits behind the router — the secondary pods included — via
 * `regionRouterOriginSecret` alone; `regionRouter=true` is only for the pod that owns the edge.
 */
export function podTrustEnv(originSecret: string | undefined): Record<string, string> {
  return originSecret ? { [POD_SECRET_ENV]: originSecret } : {};
}

const PRM_HOST_EXPR = "event.requestContext.domainName === process.env.MCP_DOMAIN";

const PRM_VIEWER_HOST_HELPER = `
        const __crypto = require("crypto");
        // Region router (pod-trust.ts): the viewer host, only with the shared secret.
        const __viewerHost = (event) => {
          const direct = event.requestContext.domainName;
          const h = event.headers || {};
          const secret = process.env.${POD_SECRET_ENV};
          const proof = h["${REGION_VERIFY_HEADER}"];
          const host = h["${VIEWER_HOST_HEADER}"];
          if (!secret || typeof proof !== "string" || typeof host !== "string" || !host) return direct;
          const a = Buffer.from(proof), b = Buffer.from(secret);
          return a.length === b.length && __crypto.timingSafeEqual(a, b) ? host.toLowerCase() : direct;
        };`;

/** The PRM source with its host test reading the trusted viewer host. */
export function trustViewerHostInPrm(source: string): string {
  if (source.split(PRM_HOST_EXPR).length !== 2) {
    throw new Error("PRM source changed: its MCP_DOMAIN host test is not found exactly once");
  }
  return PRM_VIEWER_HOST_HELPER + source.replace(PRM_HOST_EXPR, "__viewerHost(event) === process.env.MCP_DOMAIN");
}

/**
 * The connector Lambda gets the secret too (src/handler/viewer-host.ts in dilaya-connector).
 * Appended last in the stack: a new env var only, nothing above can be re-ordered by it.
 */
export function applyPodTrust(_stack: cdk.Stack, ctx: StackContext): void {
  for (const [k, v] of Object.entries(podTrustEnv(ctx.regionRouterOriginSecret))) {
    ctx.fn.addEnvironment(k, v);
  }
}
