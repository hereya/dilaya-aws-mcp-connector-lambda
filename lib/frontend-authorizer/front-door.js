// ---------------------------------------------------------------------------
// FRONT DOOR (t_app_routing_o1, option C, 23/09/2026).
//
// Until now every app backend cost the shared HTTP API one integration and two
// routes (+ an auth route, ×2 with staging): linear in apps, capped at 1 000
// routes — ~300 backends, nowhere near 10 000 orgs. The fixed replacement is
// five STATIC routes
//   ANY /o/{orgId}/{app}/site          ANY /o/{orgId}/{app}/site/{proxy+}
//   ANY /o/{orgId}/{app}/site-stg      ANY /o/{orgId}/{app}/site-stg/{proxy+}
//   ANY /o/{orgId}/{app}/auth/{proxy+}
// integrated to THIS function, which is also the frontend authorizer. It runs
// the authorizer's own decision (origin lock, request counter, monthly cap,
// rate guard, platform-closed sites, identity) exactly as before, then invokes
// the app's Lambda — or the shared auth Lambda — itself. Still two Lambdas per
// request, as today: the gatekeeper became the router, nothing was added.
//
// The forwarded event is rebuilt in the shape the per-app routes produced
// (literal routeKey, `pathParameters.proxy`, `requestContext.authorizer.lambda`
// = the authorizer's context), so a handler reading the raw event sees no
// difference. The legacy literal routes keep winning while they exist (API
// Gateway prefers the most specific match), so deploying this changes nothing
// until the connector stops creating them.
// ---------------------------------------------------------------------------
"use strict";

const TARGET_RE = /^\/o\/([^/]+)\/([^/]+)\/(site-stg|site|auth)(\/.*)?$/;
const FRONT_DOOR_ROUTE_KEYS = new Set([
  "ANY /o/{orgId}/{app}/site",
  "ANY /o/{orgId}/{app}/site/{proxy+}",
  "ANY /o/{orgId}/{app}/site-stg",
  "ANY /o/{orgId}/{app}/site-stg/{proxy+}",
  "ANY /o/{orgId}/{app}/auth/{proxy+}",
]);
const JSON_HEADERS = { "content-type": "application/json" };

// API Gateway's own wording for the answers it used to give itself.
const reply = (statusCode, message) => ({
  statusCode,
  headers: JSON_HEADERS,
  body: JSON.stringify({ message }),
});
const FORBIDDEN = () => reply(403, "Forbidden");
const NOT_FOUND = () => reply(404, "Not Found");
const APP_FAILED = () => reply(502, "Internal Server Error");
const APP_BUSY = () => reply(503, "Service Unavailable");

/**
 * A front-door event is an INTEGRATION event on one of the static generic
 * routes (its route key still names `{orgId}`). Everything else — an
 * authorizer REQUEST event on a legacy literal route — is the authorizer's.
 */
function isFrontDoorEvent(event) {
  if (!event || event.type === "REQUEST" || event.routeArn) return false;
  const key = event.routeKey || event.requestContext?.routeKey || "";
  return FRONT_DOOR_ROUTE_KEYS.has(key);
}

/**
 * Which function a path targets, before any lookup. Null = no route would
 * have matched under the per-app scheme (404).
 */
function parseTarget(rawPath) {
  const m = (rawPath || "").match(TARGET_RE);
  if (!m) return null;
  const [, orgSeg, appSeg, kind, rest] = m;
  const proxy = rest ? rest.slice(1) : undefined;
  // The auth tree was only ever `/auth/{proxy+}`: no root route.
  if (kind === "auth" && !proxy) return null;
  return {
    orgId: decodeURIComponent(orgSeg),
    app: decodeURIComponent(appSeg),
    kind,
    prefix: `/o/${orgSeg}/${appSeg}/${kind}`,
    proxy,
  };
}

/** The event exactly as the literal per-app route used to deliver it. */
function legacyEvent(event, target, authorizerContext) {
  const routeKey = target.proxy
    ? `ANY ${target.prefix}/{proxy+}`
    : `ANY ${target.prefix}`;
  const out = {
    ...event,
    routeKey,
    requestContext: {
      ...(event.requestContext || {}),
      routeKey,
      authorizer: { lambda: authorizerContext || {} },
    },
  };
  if (target.proxy) out.pathParameters = { proxy: target.proxy };
  else delete out.pathParameters;
  return out;
}

/**
 * deps: { authorize(event), appRow(orgId, app) → registry app item | null,
 *         authFunctionName, appFunctionPrefix, lambda? }
 */
function makeFrontDoor(deps) {
  // Loaded on first use: the authorizer path (legacy routes) never needs it.
  // maxAttempts 1 — a POST must never be replayed behind the visitor's back.
  let lambda = deps.lambda;
  const invoke = (input) => {
    const sdk = require("@aws-sdk/client-lambda");
    if (!lambda) lambda = new sdk.LambdaClient({ maxAttempts: 1 });
    return lambda.send(new sdk.InvokeCommand(input));
  };

  function functionFor(target, row) {
    if (target.kind === "auth") return deps.authFunctionName || null;
    if (!row) return null;
    const fn = target.kind === "site-stg" ? row.stgLambdaFunctionName : row.lambdaFunctionName;
    // Only ever a function the platform created for a tenant: never a name a
    // registry row could point anywhere else.
    if (typeof fn !== "string" || !deps.appFunctionPrefix || !fn.startsWith(deps.appFunctionPrefix)) {
      return null;
    }
    return fn;
  }

  return async function frontDoor(event) {
    const target = parseTarget(event.rawPath || event.requestContext?.http?.path || "");
    if (!target) return NOT_FOUND();

    const verdict = await deps.authorize(event);
    if (!verdict || !verdict.isAuthorized) return FORBIDDEN();

    let row = null;
    if (target.kind !== "auth") {
      try {
        row = await deps.appRow(target.orgId, target.app);
      } catch (err) {
        console.error("front-door: registry lookup failed:", err?.message || err);
        return APP_BUSY();
      }
    }
    const fn = functionFor(target, row);
    if (!fn) return NOT_FOUND();

    const started = Date.now();
    let res;
    try {
      res = await invoke({
        FunctionName: fn,
        Payload: Buffer.from(JSON.stringify(legacyEvent(event, target, verdict.context))),
      });
    } catch (err) {
      const name = err?.name || "";
      console.error(JSON.stringify({ type: "front_door_invoke_failed", org: target.orgId, app: target.app, kind: target.kind, error: name, message: String(err?.message || err).slice(0, 200) }));
      if (name === "ResourceNotFoundException") return NOT_FOUND();
      if (name === "TooManyRequestsException") return APP_BUSY();
      return APP_FAILED();
    }
    if (res.FunctionError) {
      console.error(JSON.stringify({ type: "front_door_app_error", org: target.orgId, app: target.app, kind: target.kind, functionError: res.FunctionError, ms: Date.now() - started }));
      return APP_FAILED();
    }
    const text = Buffer.from(res.Payload || []).toString("utf8");
    // Returned VERBATIM: API Gateway then applies to it the very inference it
    // applied to the app's own answer (a bare object/string → 200 JSON body).
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return APP_FAILED();
    }
  };
}

module.exports = { FRONT_DOOR_ROUTE_KEYS, makeFrontDoor, isFrontDoorEvent, parseTarget, legacyEvent };
