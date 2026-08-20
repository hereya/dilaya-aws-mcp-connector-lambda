# dilaya/aws-mcp-connector-lambda

The **deploy package** for the multi-tenant **Dilaya MCP connector** (`dilaya/connector`). It
provisions a single Lambda behind an HTTP API Gateway v2 that serves **ONE `/mcp` endpoint for every
organization** — the org is selected inside the OAuth token, not by a per-org deployment. Forked
from `hereya/aws-mcp-app-lambda`; the per-org fork keeps using that original package untouched.

Database, storage, and other infra come from separate Hereya packages (`dilaya/aws-sqlite-data`,
`hereya/aws-file-storage`, `hereya/postmark-account-credentials`, …). Their outputs (IAM policies,
`dataApiUrl`, bucket names, secrets) arrive via `hereyaProjectEnv` and are injected into the Lambda.

## Multi-tenant model (no bound org)

There is **no mandatory `organizationId`**. When `organizationId` is empty (the norm), the authorizer
runs in **multi-tenant** mode: it validates the JWT from the single-URL **connect OAuth AS** (issuer
`https://dilaya.eu/oauth/connect`), checks the RFC 8707 `aud` = `https://<customDomain>/mcp`, and
injects `userId` / `orgIds` (the token's **org set**) / `orgRole` into every request. (If
`organizationId` *is* set, it falls back to legacy single-org binding — used only by the retired
per-org app.)

## Routes

```
POST /mcp                                  → JWT authorizer (org_ids) → connector Lambda   (401 on reject)

Static public routes (NO authorizer — self-authenticating):
  POST /o/{orgId}/{app}/agent/token        → exchange a single-use setup token for a poll token
  GET  /o/{orgId}/{app}/agent/poll         → Bearer poll token → { shouldWake, mode, lifecycle }
  POST /o/{orgId}/{app}/telegram/webhook   → inbound Telegram (secret-token verified)
  GET/POST /o/{orgId}/{app}/telegram/setup → one-time bot-token entry form
  GET/POST /o/{orgId}/{app}/secrets/setup  → one-time integration-secret entry form
  POST /o/{orgId}/{app}/mail/send          → app-mail gateway (Bearer = the app's DILAYA_CAPABILITY)
```

Per-app web frontends are served at the path URL `https://<customDomain>/o/<org>/<app>/site/` (and,
when the app-content edge layer is on, additionally at a flat vanity host — see below).

## App-content edge layer (flat vanity hosts) — optional

Set all three params together to additionally serve each app's frontend at
`<app>--<orgslug>.<appContentDomain>` (e.g. `smartcal--novopattern.dilaya-apps.eu`), **in addition**
to the path URL. Omitted → the feature is fully inert (no CloudFront, no DNS, no `cloudfront:*` IAM).

| Parameter | Required | Description |
| --- | --- | --- |
| `appContentDomain` | optional | The content domain (e.g. `dilaya-apps.eu`). Absent → feature off. |
| `appContentZoneId` | with domain | Route53 hosted-zone id for `appContentDomain`. |
| `appContentCertArn` | with domain | us-east-1 ACM ARN of the pre-created `*.<appContentDomain>` wildcard cert (passed in, NOT created by CDK). |

When enabled, the stack provisions a CloudFront distribution (alt name `*.<appContentDomain>`,
wildcard viewer cert) fronting the same API-Gateway origin, a wildcard Route53 A/AAAA record, and a
**viewer-request CloudFront Function** holding a baked host→`{org,app}` map. The function rewrites a
vanity-host request to the existing `/o/<org>/<app>/{site|auth}/…` route and tags the viewer host in
`x-dilaya-app-host`. The connector regenerates that map at runtime (`GetFunction` → `UpdateFunction`
→ `PublishFunction`) as apps are given hosts; the cert + DNS are static and never change per host.

## `hereyaProjectEnv` contract

- `iamPolicy*` keys → attached to the Lambda role as IAM policies.
- `secret://…` values → consolidated into Secrets Manager and exposed via `SECRET_KEYS`.
- plain values → env vars.

Per-app frontend Lambdas (the `frontend-authorizer` + `auth-lambda`) additionally get a narrow SSM
read ceiling of `/dilaya/<orgId>/apps/<app>/{mail,secrets}/*` (own-app Postmark token + integration
secrets) plus KMS-via-SSM decrypt.

## The edge lambdas' Data API client

`frontend-authorizer` and `auth-lambda` each hold their **own** SigV4 Data API client (`dataApiQuery`,
node builtins only — they cannot import the connector's TypeScript one). It must therefore mirror the
connector's `src/dataapi-client.ts` retry behaviour, and does: a **short, bounded retry** (2 extra
attempts, 150 ms then 300 ms) on the states the VM itself calls transient — **429 / 502 / 503 / 504**
— and on a network blip. Anything else (4xx, bad SQL, a capability denial) fails on the first attempt.

Without it a few-second VM bounce (`503 UNAVAILABLE: instance is shutting down; retry shortly`) reads
as *"this app has no auth config"*: a logged-in visitor is served as anonymous and bounced to
`/auth/login`, and the login page can't work either — an availability bug, never an identity leak
(the failure path grants no identity, it only withholds one). Observed for real on 2026-07-29, where
the connector logged 0 errors through the same bounce precisely because its client retried.
Unit-pinned for both copies in `test/dataapi-retry.test.ts`.

## Alarms, and the relay that makes them audible

`CapabilityRejectedAlarm` watches a metric filter on the connector's own log group
(`"capability rejected"` → `Dilaya/Connector CapabilityRejected`, ≥1 in 5 min).

⚠️ **An alarm with no action is a dashboard, not an alert.** This one shipped in 2026-07 with zero
actions, on the idea that "the alarm state itself is the signal" — nothing polls an alarm's state, so
its only reader was the twice-daily log sweep, i.e. exactly the ~21 h delay the alarm was built to
remove. Worse, the task that shipped it recorded that it delivered `SNS→Telegram`. Found and closed
by the 2026-08-08 sweep.

Supply **both** inputs and the stack builds an SNS topic + an `AlarmRelay` Lambda subscribed to it,
and wires the alarm's ALARM **and** OK actions to that topic:

| input | meaning |
|---|---|
| `telegramBotTokenParam` | **name** of the SSM SecureString holding the bot token — never the token. May point at the `attach-telegram` credentials record (`{"bot_token":…,"secret_token":…}`); the relay extracts `bot_token`. |
| `telegramChatId` | chat notified when an alarm flips, and when it recovers. |

Either one missing → no topic, no relay, alarm unchanged. The two names are **identical to
`dilaya/aws-sqlite-data`'s** on purpose: one pair of `-p` values in the connector's `release.yml`
feeds both packages.

⚠️ **Declare before you read.** A package only receives an input listed under `parameters:` in its
`hereyarc.yaml`; an undeclared or renamed one is dropped **in silence** and the deploy still goes
green — three releases were burned that way on 2026-08-07. `test/alarm-relay.test.ts` pins the names
on both sides, plus the fact that the alarm carries actions and the topic carries a subscriber
(each of which fails invisibly).

**Verify on real prod, never on a green run:** the relay Lambda must exist, the topic must report
≥ 1 subscription, and the alarm must be flipped for real (`aws cloudwatch set-alarm-state`) with the
message actually arriving.

### What is alarmed (14 alarms), and why each layer needs its own

Alarms are created **unconditionally** — they stay readable in CloudWatch and other subscribers stay
possible; only the *speaking* depends on the two inputs above.

| Alarm | Threshold | The blind spot it covers |
|---|---|---|
| `Errors` + `Throttles`, per Lambda (5 functions → 10 alarms) | ≥ 1 / 5 min | the layer that throws |
| `HttpApiPlatform5xx` (metric math: `HttpApi5xx - HttpApi5xxTenantApp`) | ≥ 1 / 5 min | a 502/504 at the **gateway** never makes the Lambda throw, so `AWS/Lambda Errors` reads 0 |
| `AppStateTable` `SystemErrors` + `ThrottledRequests` | ≥ 1 / 5 min | a throttled state write is neither a Lambda error nor a gateway error |

Thresholds are calibrated on the **measured** baseline, not guessed: Lambda `Errors`/`Throttles` have
been flat 0 since 2026-08-03, and gateway `5xx` 0 since 2026-08-05 21:03Z with the landing API as a
control at 0 over 7 days. Against an empirically zero floor, "≥ 1 in 5 minutes" is the smallest
signal that means something happened, not a noisy one.

`treatMissingData` is `NOT_BREACHING` everywhere — a function with no traffic reports no datapoint,
and that is silence, not failure.

**The gateway 5xx alarm counts only the 5xx that are OURS.** The gateway is shared by every tenant
site and backend, so the raw `AWS/ApiGateway 5xx` metric counts a client's app failing on its own
routes as a platform incident. That is not theory: over 30 days and 26 alarms, the *only* unplanned
firing was this alarm, 4× on 2026-08-14, on 10 requests that all carried `int=200` on
`…/komlaba/site-stg/…` — a client's pre-production site returning 500 on two of its own routes.

Two metric filters over the access log answer "whose?", and the alarm is their difference:

| Metric (`Dilaya/Connector`) | Filter pattern | Meaning |
|---|---|---|
| `HttpApi5xx` | `{ $.status = "5*" }` | every 5xx the gateway served |
| `HttpApi5xxTenantApp` | `{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }` | the tenant's own app answered 500 |

Both signals are required. `integrationStatus = 200` alone would also swallow **our** handler's own
500s (they answer normally too) — trading a noisy alarm for a blind one; the `…/site…` route keys are
the only ones wired straight to an `app-app-*` Lambda. Values are matched as **strings**, because
that is how the access log writes them (`"status":"500"`) — a numeric comparison matches nothing and
leaves an alarm that looks healthy and never fires. Both filters carry `DefaultValue: 0`, without
which a period with no tenant 5xx has no datapoint and the subtraction is *dropped* rather than
evaluated. The two filters read the **same** log events on purpose: pairing one with the gateway's
own metric would let ingestion skew invent a difference across a period boundary.

A tenant integration that times out or is refused (`int != 200`) still counts as ours — the gateway
could not get a normal answer, and that is a platform question until proven otherwise. Alerting the
org that owns a failing app is a separate, unbuilt concern; `HttpApi5xxTenantApp` is its raw
material.

**`4xx` is deliberately NOT alarmed.** It runs 30–85/day of scanner noise absorbed by tenant apps
(all `int=200`, i.e. the tenant's own app answering). Alarming it would train everyone to ignore this
topic, which is exactly how an alarm layer dies a second time. `ByodOriginRestamp` is likewise left
out: it is a deploy-time trigger, so its failure fails the deploy rather than hiding in prod.

`test/core-alarms.test.ts` asserts the **population**, not just individual alarms — in particular
that *no* alarm is left without actions once the relay is configured, so a future alarm added without
`alertOn()` fails there instead of surfacing in a sweep six weeks later. Both test files are
mutation-checked: removing the wiring makes them fail.

## Build & ship

CDK (`iac: cdk`). It **synths from TypeScript via ts-node** (`cdk.json` → `npx ts-node --prefer-ts-exts
bin/…ts`), so **edit the `.ts` under `lib/` — the committed `.js` is vestigial** (gitignored build
output). No CI in this repo: publish a new version by bumping `hereyarc.yaml`, committing, pushing,
and running `hereya publish`. The connector's `hereya.yaml` pins the version; to roll a change to
prod, publish here, bump that pin, then do a `dilaya/connector` release (on an explicit deploy GO).

```bash
npm run build   # tsc (typecheck; the .js it emits is not shipped)
```
