import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";

/**
 * The App UI origin's response headers (app-ui-frame.ts). The CSP is the
 * security boundary of an AI-written bundle; every directive is deliberate:
 *   - script-src 'self' — no inline script, no eval, no third-party code;
 *   - connect-src 'none', frame-src/worker-src/object-src 'none' — no network
 *     reach from the bundle: it talks to the console over a MessageChannel only;
 *   - img-src adds the files host (presigned file links), when one is set;
 *   - form-action/base-uri 'none'; frame-ancestors = the console origin only;
 *   - `sandbox allow-scripts allow-forms` — the document is sandboxed even when
 *     opened top-level, outside the console's iframe (opaque origin either way).
 * Access-Control-Allow-Origin: * is what lets a sandboxed (Origin: null)
 * document load its own `type="module"` scripts, which are CORS requests; the
 * bundles hold no secret, credentials are never allowed.
 */
export interface AppUiHeaderInput {
  consoleOrigin: string;
  filesHost: string | undefined;
}

export function appUiCsp(input: AppUiHeaderInput): string {
  const img = ["'self'", "data:", "blob:", ...(input.filesHost ? [`https://${input.filesHost}`] : [])].join(" ");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img}`,
    "font-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${input.consoleOrigin}`,
    "sandbox allow-scripts allow-forms",
  ].join("; ");
}

/** Every powerful feature denied, to every origin. */
export const PERMISSIONS_POLICY = [
  "accelerometer", "ambient-light-sensor", "autoplay", "bluetooth", "camera", "display-capture",
  "encrypted-media", "fullscreen", "geolocation", "gyroscope", "hid", "identity-credentials-get",
  "idle-detection", "magnetometer", "microphone", "midi", "payment", "picture-in-picture",
  "publickey-credentials-create", "publickey-credentials-get", "screen-wake-lock", "serial",
  "storage-access", "usb", "web-share", "xr-spatial-tracking",
].map((f) => `${f}=()`).join(", ");

export function appUiResponseHeaders(stack: cdk.Stack, input: AppUiHeaderInput): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(stack, "AppUiHeadersPolicy", {
    comment: "App UI sandbox origin: strict CSP, no referrer, no features",
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy: appUiCsp(input), override: true },
      contentTypeOptions: { override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: false, override: true },
    },
    corsBehavior: {
      accessControlAllowOrigins: ["*"],
      accessControlAllowMethods: ["GET", "HEAD"],
      accessControlAllowHeaders: ["*"],
      accessControlAllowCredentials: false,
      originOverride: true,
    },
    customHeadersBehavior: {
      customHeaders: [{ header: "Permissions-Policy", value: PERMISSIONS_POLICY, override: true }],
    },
  });
}
