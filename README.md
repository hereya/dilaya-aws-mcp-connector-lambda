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

### Host-map value flags, and the login gate (0.1.73)

Each host's KVS value is `{ o, a, p?, r?, e?, x?, auth?, pub? }`, written by the connector
(`desiredKvsState`) and read by the viewer-request function (`lib/stack/app-content/router-function.ts`
— its comment lines are stripped at synth, the edge has a 10 KB code budget): `o`/`a` org + app,
`p` static-section prefixes, `r` canonical-redirect host, `e:"s"` staging, `x` stopped (1 paused
org, 2 past its monthly allowance), and since 0.1.73 **`auth: 1`** — *the platform closes the site*
(t_frontend_auth_default): a request with no session cookie (`dilaya_id_token` / `hereya_id_token` /
`dilaya_agent`) is answered at the edge with a 302 to `/auth/login?return_url=<path>` (`/api/*`: 401
JSON), except `/auth/*`, `/static/*` and the app's **`pub`** prefixes (`"/"` = the root page only).
That is a presence check (no crypto at the edge) — the UX, and the only thing that can protect a
STATIC section (S3 never reaches an authorizer). The guard is the **frontend authorizer**: for an app
whose registry row carries `authEnforce: true` it REFUSES (403) an anonymous request for any site path
outside `publicPaths` / `/static/*`, and fails closed when the pool row or the registry cannot be
read. Apps without the flag keep the legacy contract (authorized, anonymous — their handler decides).
The auth Lambda's session cookie now lives exactly as long as the ID token (`idTokenMaxAge`, 1 h by
default) instead of a flat 24 h, so an honest browser's "cookie present" means "token still valid".

## Presigned file URLs on a Dilaya host — optional

With `filesDomain` + `filesZoneId` + `filesCertArn`, `lib/stack/files-domain.ts` stands up a pass-through
CloudFront distribution in front of the `hereya/aws-file-storage` bucket (`bucketName`, read from
`hereyaProjectEnv`), A/AAAA records for `filesDomain`, and `FILES_PUBLIC_HOST` on the connector —
which then swaps only the HOST of every presigned URL. Why: sandboxed environments (Claude Cowork,
ChatGPT work) block `*.amazonaws.com`.

Nothing is re-signed. A presigned SigV4 URL covers `Host`, and it still verifies because CloudFront
sends an S3 origin the origin's own host. That holds only for the exact shape the tests pin: an S3
origin **without** OAC/OAI (the authorization is in the query string and S3 still decides),
`Managed-AllViewerExceptHostHeader`, `Managed-CachingDisabled`, every method. Proven end to end on
throwaway resources before this was written: GET 200, tampered signature 403, PUT 1 KB, PUT 150 MB
over 77 s, multipart — all 200. The certificate is passed in (us-east-1), like the app-content one.
Absent `filesDomain` → nothing is created. The step is appended LAST in the constructor, so the
golden templates are byte-identical with the feature off.

**The human transfer page** (`/_transfer`, t_dad9f0e09ffb, 0.1.76). The same distribution carries one more
behavior, `/_transfer*` (GET/HEAD, uncached), whose viewer-request CloudFront Function answers a
self-contained page itself — the bucket is never asked for that path, and no object key can collide
(every key starts with the storage prefix). When a sandbox blocks the connector's programmatic
transfer, the connector hands a person `https://<filesDomain>/_transfer#<payload>`: they upload
(presigned **POST** to `/` — the policy enforces key, size range, Content-Type and a transfer id) or
download (presigned GET as attachment) from their own browser, on the SAME origin as the presigned
URLs, so no CORS and no Lambda in the byte path. The payload lives in the fragment, which never
reaches a server. The page's script and style are pinned by hash in its CSP; a download target that
is not a same-origin path is refused. Source: `lib/stack/files-transfer/` (the payload contract is
shared with the connector's `src/storage/transfer-link.ts`); `test/files-domain/transfer-page.test.ts`
executes the synthesised function. Proven 16/09 from headless Chrome against the live distribution
before shipping: upload 201, over-size 400 EntityTooLarge, 200 MB in 39 s, download 200 attachment.

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

## Passkeys on the auth Lambda (t_auth_passkey)

The shared `auth-lambda` also serves a **WebAuthn passkey** sign-in, Cognito-native — the Lambda
stores and verifies nothing. The connector's `enable-auth` turns it on per app (pool
`SignInPolicy` `WEB_AUTHN`, `SetUserPoolMfaConfig.WebAuthnConfiguration.RelyingPartyId`, client
`ALLOW_USER_AUTH`) and writes `passkeys` / `passkey_rp_id` on `_auth_config`; the Lambda reads
them with the rest of the row (60 s cache; a row without the columns = off).

- **Sign-in:** the login page pre-fills the e-mail (`dilaya_last_email`, HttpOnly, 90 d) and, on the
  rpId host only, reveals a "Sign in with a passkey" button. `POST auth/passkey/start` →
  `InitiateAuth(USER_AUTH, PREFERRED_CHALLENGE=WEB_AUTHN)` → the `CREDENTIAL_REQUEST_OPTIONS`
  string goes to `navigator.credentials.get` → `POST auth/passkey/finish` →
  `RespondToAuthChallenge(WEB_AUTHN, CREDENTIAL=<JSON string>)` → the **same** `dilaya_id_token`
  cookie an OTP sets (the frontend authorizer is untouched). Every miss (no passkey for that
  e-mail, cancelled dialog, Cognito error) submits the OTP form with `passkey_fallback` — the code
  page then says why. Never a dead end.
- **Registration:** after a successful OTP on the rpId host, `POST verify` 302s to
  `GET auth/passkey/register` with the fresh **AccessToken in a 5-minute HttpOnly cookie**
  (`dilaya_at`, never in HTML); "Set up on this device" → `POST auth/passkey/register/start`
  (`StartWebAuthnRegistration`) → `navigator.credentials.create` → `POST …/register/finish`
  (`CompleteWebAuthnRegistration`, credential as an object). Done or declined, the session
  cookie was already set. `dilaya_pk=1` (1 y) marks a device that registered, so the offer is not
  repeated into an "already registered" dialog.
- **Registration also CONFIRMS the user.** Cognito offers the `WEB_AUTHN` challenge only to a
  `CONFIRMED` user, and every app user is admin-created, i.e. `FORCE_CHANGE_PASSWORD` for life
  (the OTP flow never changes the status) — in that state `USER_AUTH` answers with password factors
  only, whatever passkeys the user holds (proven in prod, 2026-09-13). So `register/finish`, after
  `CompleteWebAuthnRegistration`, sets a random **permanent** password nobody knows
  (`AdminSetUserPassword`, 0.1.71); the response carries `confirmed:true|false`.
- **One passkey = one host.** The rpId is the app's principal host (verified custom domain, else
  the vanity host — chosen by the connector); the staging host, secondary domains and the path
  URL keep the OTP (`passkeyHostMatches`). Browsers enforce the same rule; the gate only keeps
  the button from appearing where it could only fail.

- **Cookies must be forwarded.** CloudFront strips every cookie not on the app-content
  origin-request policy's allowlist (`lib/stack/app-content/policies.ts`, `SESSION_COOKIES` — shared
  by id with every BYOD distribution), silently: in prod on 2026-09-13 the offer page bounced
  straight through because `dilaya_at` never reached the Lambda. Any new cookie the auth Lambda
  reads goes on that list first (0.1.69).

Pinned in `test/auth-passkey-{pages,signin,register}.test.ts` (Cognito mocked, Data API +
registry faked — `test/helpers/auth-lambda-passkey.ts`).

## No address enumeration on the login page (t_login_enumeration, 0.1.74)

The shared login page used to answer « No account found for this email » — a different page for an
unknown address than for a known one, i.e. an oracle over a customer's user list, address by address.
Every address now gets the SAME code page (« if this address has access, a code has just been sent »).
An address that gets no code (not allowlisted, unknown to Cognito, auth not enabled) carries a
**decoy session**: 600 random bytes + a 32-byte HMAC tail under a key derived from the capability
secret, base64 like the real ones, so `verify` recognises it without storing anything and answers
« incorrect code » — exactly what a wrong code on a real session gets — without asking Cognito. A
small jitter stands in for the Cognito + Postmark round-trips of the real path. `passkey/start`
answers an off-list address like one without a passkey (`no_passkey`), so the client falls back to
the uniform e-mail path. One `auth_no_code` log line (app + reason, never the address). Without a
capability secret (local runs) the key is per-process. `test/auth-no-enumeration.test.ts`.

## The state table's recovery path

`AppStateTable` started life as cheap "is there something new?" flags, and the comment above it still
said so long after it had stopped being true: it holds the **agent definitions** (the hand-written
prompt, the wake signal, the poll token) and the **consumption ledgers billing reads** (`usage#`,
`usageorg#`, `quota#`, `llmspend#`, `mailcount#`), plus the agent inboxes and the Telegram bot config.
On 2026-08-20 it was the largest table on the platform and had **PITR disabled + `RemovalPolicy.DESTROY`**,
while `RegistryTable` — created by our other package, `dilaya/aws-sqlite-data` — had PITR + RETAIN.
With no on-demand backup and no AWS Backup plan anywhere in the account, that left it with **no
recovery path at all**: one bad write, failed migration or destroyed stack and the prompts and the
billing counters were gone, not recoverable even by a minute.

Both tables here now carry `pointInTimeRecoverySpecification`, and `AppStateTable` carries `RETAIN`
(the OTP table keeps `DESTROY` — nothing in it outlives a login attempt). PITR costs ~0.20 $/GB/month,
i.e. ~0.13 $/month at the state table's size. `test/table-recoverability.test.ts` asserts the
**population**: a table added later without PITR fails there rather than in a sweep six weeks later.

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

### Per-route metrics: on for our routes, off for the tenants'

API Gateway emits six metrics per route (`Count`, `Latency`, `IntegrationLatency`, `DataProcessed`,
`4xx`, `5xx`), each billed as a **custom** metric at $0.30/month, prorated by the hours the route
sees traffic. `detailedMetricsEnabled` used to be on for the whole stage, which meant the one or two
routes `set-app-host` creates **at runtime** per customer frontend each added six billed metrics —
so the monitoring bill grew with the customer list, and nothing said so. Measured 2026-08-29:
$9.18/month of route metrics, $4.24 of it tenant `…/site…` / `…/auth…` routes, against $3.50 for all
35 alarms in the account put together.

So the stage default is now `false`, and the routes **this stack defines** carry
`DetailedMetricsEnabled: true` in their own `RouteSettings`, derived by walking the construct tree —
not from a hand-written list, so a route added here tomorrow is covered the day it is added. The
cost is bounded by a route count this file controls instead of by how many customers have a
frontend.

Nothing was traded away for it. No alarm reads these metrics — the platform/tenant 5xx split above
is built from log metric filters — and the access log already writes `routeKey`, `status` and
`integrationStatus` for **every** request over the same two weeks the sweep reads, which is the finer
signal, not the coarser one. What is gone is only the multi-month curve per tenant route in
CloudWatch.

Each route's settings **restate** the throttling ceiling rather than inheriting it: API Gateway's
merge rule between a route's settings and the stage default is not something to bet a last-resort
ceiling on, so the platform routes carry the numbers explicitly and a test asserts the two never
diverge.

**`4xx` is deliberately NOT alarmed.** It runs 30–85/day of scanner noise absorbed by tenant apps
(all `int=200`, i.e. the tenant's own app answering). Alarming it would train everyone to ignore this
topic, which is exactly how an alarm layer dies a second time. `ByodOriginRestamp` is likewise left
out: it is a deploy-time trigger, so its failure fails the deploy rather than hiding in prod.

`test/core-alarms.test.ts` asserts the **population**, not just individual alarms — in particular
that *no* alarm is left without actions once the relay is configured, so a future alarm added without
`alertOn()` fails there instead of surfacing in a sweep six weeks later. Both test files are
mutation-checked: removing the wiring makes them fail.

## Source layout — the stack is a list of build steps

`lib/dilaya-aws-mcp-connector-lambda-stack.ts` used to be one 3 100-line constructor. It is now a
short, ordered list of calls into `lib/stack/`, each step a file of at most 220 lines:

```
lib/stack/context.ts          what the steps hand to each other (+ the field-by-field contract)
lib/stack/constants.ts        EDGE_LOG_PREFIX, LIB_DIR
lib/stack/config.ts           the synth environment, read once
lib/stack/project-env.ts      hereyaProjectEnv split into policy / plain / secret
lib/stack/*.ts                the connector Lambda, the HTTP API, routes, IAM, the state table
lib/stack/app-content/*.ts    the flat-vanity-host edge layer (inert without appContentDomain)
lib/stack/frontend-distribution/*.ts   the legacy per-org *.customDomain distribution
lib/stack/alarms/*.ts         every alarm, and what each one is blind to
```

Every construct is still created with the **stack itself** as its scope, so logical ids — and
therefore the deployed resources — are unchanged by the split.

**Two things about this arrangement are load-bearing.**

1. **The order of the calls in the constructor.** `addToRolePolicy` appends to the connector role in
   call order, so swapping two steps rewrites the synthesized policy document. A step also reads
   context fields only an earlier step sets.
2. **`__dirname` is not where the assets are.** A step lives one or two directories below `lib/`,
   so asset paths go through `LIB_DIR`, never through the step's own `__dirname`.

### Proving a change to the stack kept the template intact

`npx ts-node --prefer-ts-exts scripts/synth-golden.ts <dir>` synthesizes the stack under four env
profiles — minimal, custom domain + Cognito + runtime layer, the full production shape, and the
same features with every optional sub-feature off — and writes one template JSON per profile. Run
it before a refactor, run it after, `diff -r` the two directories.

Neither `tsc` nor a green `cdk synth` can see a moved resource or a re-ordered policy statement;
this can. It is what proved the split above changed nothing (105 / 127 / 148 / 120 resources,
byte-identical). **Run it with `--prefer-ts-exts`**: without it, `ts-node` resolves the stale
`lib/*.js` left by a previous `tsc` and you will be comparing yesterday's stack against itself.

## Build & ship

CDK (`iac: cdk`). It **synths from TypeScript via ts-node** (`cdk.json` → `npx ts-node --prefer-ts-exts
bin/…ts`), so **edit the `.ts` under `lib/` — the committed `.js` is vestigial** (gitignored build
output). Publish a new version by bumping `hereyarc.yaml`, merging, and creating a **GitHub release
`v<version>`** (the tag must equal the `hereyarc.yaml` version): `.github/workflows/publish.yml` runs
`hereya publish` with the org's `HEREYA_TOKEN`, so no local Hereya login is needed (a local
`hereya publish` still works; a failed publish of the same version is retried via the workflow's
manual dispatch). `hereya publish` sends metadata only (repository URL, commit, sha256 of
`git archive HEAD`) — nothing is built in CI. **Publishing does not deploy**: the connector's
`hereya.yaml` pins the version; to roll a change to prod, publish here, bump that pin, then do a
`dilaya/connector` release (on an explicit deploy GO).

```bash
npm run build   # tsc (typecheck; the .js it emits is not shipped)
```
