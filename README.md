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
POST /          (plugin host mcp.<zone>)   → SAME authorizer function, ALWAYS invoked (no identity
                                             source, no cache) → connector Lambda — a request with NO
                                             Authorization header gets the connector's 401 + WWW-Authenticate,
                                             not the gateway's bare one (0.1.102, t_dir_401_www_auth)

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
Before the gate, on every site, a cookie-less dot-path (0.1.100) or server-side script path (0.1.107,
`.php`/`.asp`/`.jsp`/`.cgi`…) is answered `404 no-store` at the edge — no redirect, no Lambda;
since 0.1.109 both rules test the path DECODED (two passes), so `/%2Eenv` meets the same 404 as `/.env`.
Since 0.1.110 an anonymous GET/HEAD of `/auth/login?return_url=<path>` — the form a site closed by its OWN
code still emits — is answered at the edge with a 302 to `/auth/login#r=<path>` (other params kept, path
filtered to a relative one), so the cached login page serves there too: one render a minute per site.
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
transfer, the connector hands a person `https://<filesDomain>/_transfer#<id>`: they upload
(presigned **POST** to `/` — the policy enforces key, size range, Content-Type and a transfer id) or
download (presigned GET as attachment) from their own browser, on the SAME origin as the presigned
URLs, so no CORS and no Lambda in the byte path. The fragment is a SHORT id (0.1.111,
t_transfer_short_link — a 2 900-character inline payload got retyped by an assistant and lost 9
characters of its session token): the page POSTs it in the body to `/_t` on its own origin, a second
behavior this distribution proxies to the connector's HTTP API (public route `POST /_t`, the id being
the secret), and receives the signed material; the legacy inline-JSON fragment is still honoured. The
page's script and style are pinned by hash in its CSP; a download target that
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

## The login page under a burst (t_login_burst_authlambda, 0.1.104)

The auth Lambda is **one function with 50 reserved slots, shared by every tenant site**, and a cold
login page is a 3–5 s render (registry + branding + SSM per instance). On 2026-10-10 a single Google
Cloud address loaded one app's `/auth/login` **101 times in 10 s** and held **29 of the 50** slots;
the 06/10 variant of the same scanner (dot-paths redirected to login, since closed) reached the cap —
117 throttles, every site's login down for the burst. At ~600/minute the burst sat far under both
site guards (1 000/minute, 2 000/quarter-hour). Two brakes, both on by default:

1. **The anonymous login page is cached at the edge for 60 s.** The auth Lambda answers the GET with
   `Cache-Control: max-age=0, s-maxage=60` (`loginPageResponse`, the only cacheable shape it has):
   the CDN keeps it a minute, the browser revalidates as before, no `public` for other caches. The
   app-content cache policy already honoured origin Cache-Control (min TTL 0) and keyed on every
   query string and the session cookies — `return_url`, `?email=`, a `dilaya_last_email` pre-fill
   and an expired id-token cookie each get their own entry — and now also keys on
   **`x-dilaya-app-host`** (the passkey button shows on the rpId host only) and **`Accept-Language`**
   (an app without a stored language renders the browser's). Both were already forwarded; a header in
   the key changes nothing for the origin. The 302 for a signed-in visitor carries no Cache-Control
   and is never cached; the path URL (`app.dilaya.eu/o/…`) runs with caching disabled. A plain burst
   now costs the origin one render per app per minute.
2. **The login tree has its own per-IP minute counter in the frontend authorizer** — `60` per
   (app, address, minute) on `/auth/*` only, **enforced** (`rate_guard` line, `window: "1m-auth"`,
   `blocked: true` → 403), the same atomic-ADD row shape as the two site counters
   (`rateauth#<org>#<app>#<ipTag>#<minute>`), written on no other path. A login is at most five
   requests, so 60 is twelve full logins a minute from one address; it holds a burst that defeats the
   cache (a varying query string, the POSTs) at ~1/s × 5 s ≈ 5 slots instead of 29.
   `FRONTEND_AUTH_RATE_BLOCK=false` → count only; `FRONTEND_AUTH_RATE_LIMIT=0` → no counter. The
   `RateGuardAlarm` fires on the same line as before — read `window` to know which counter tripped.

Deliberately **not** done: raising the reserved concurrency (moves the ceiling, closes nothing, eats
the account's shared budget) — the headroom alarms below say the day that becomes the right move. Pinned by `test/auth-login-cache.test.ts`, `test/login-page-cache-key.test.ts`
and `test/rate-guard-auth.test.ts`.

**0.1.106 — the brake had no IAM (t_rateauth_leadingkeys, 2026-10-12).** 0.1.104 shipped the
`rateauth#` row without adding it to the authorizer's `dynamodb:LeadingKeys` allow-list on
AppStateTable: every UpdateItem was refused, the fail-open `catch` served every page, and the brake
counted **nothing** for its first day (228 `auth rate check failed` lines in 24 h, no customer
impact). The grant now names five families, and `test/app-state-leading-keys.test.ts` reads the
handler's pk builders and the synthesized policy side by side — a counter family can no longer leave
before its IAM.

**0.1.107 — the cache cannot absorb a scanner; the edge answers it (t_scanner_ext_404, 2026-10-12).**
The `RateGuardAlarm` fired for real for the first time at 12:14Z: an Azure address probed **282 PHP
paths** on a closed site in 3 min (`/wp-cron.php`, `/xmlrpc.php`, `/.well-known/wp-login.php`…). The
gate turned each one into `302 /auth/login?return_url=<that path>`, and since the query string is
part of the login page's cache key, the 60 s cache served **4 of 207** — the other 203 ran the auth
Lambda until the 60/min brake refused the rest (74 × 403; concurrency stayed at 1, no customer
impact). The brake bounds the damage at 60 Lambda runs per (address, app, minute); it does not remove
it. So the dot-path rule of 0.1.99/0.1.100 now has a sibling in `router-login-gate.ts`: a cookie-less
request whose path ends in a **server-side script extension** (`.php`/`.phpN`/`.phtml`/`.asp`/
`.aspx`/`.jsp`/`.jspx`/`.cgi`/`.pl`/`.cfm`, any case, `/.well-known/` included this time) gets
the same bare `404 no-store` at the edge, on every site — no redirect, no Lambda. A site is served by a
JS handler; 14 days of edge logs (172 677 requests, 61 000 of them on such paths) hold not one answered
200. A signed-in visitor is untouched. Pinned by `test/apphost-router-behavior/login-gate.test.ts`.

**0.1.108 — the return path rides in the fragment, so the login page has ONE cache key per site
(t_login_return_fragment, 2026-10-13).** Four real `RateGuardAlarm` firings in 23 h (12:14Z,
22:12Z, 03:53Z, 10:47Z — three sites, three addresses) had the same shape as 0.1.107's, on paths no
edge rule can close: `/dashboard`, `/form/`, `/webhook-test/`, `/wrangler.toml`, `/values.yaml`,
`/var/run/secrets/…/token` — generic names that could be a real page. Each one became
`302 /auth/login?return_url=<that path>`, each a distinct cache key, so the 60 s cache absorbed none:
up to **174 origin renders a minute** and **32 of the auth Lambda's 50 shared slots** held by one
scanner (a second one at the same time would have refused every site's login). The root cause is the
cache key, not the list of paths: the gate now redirects to **`/auth/login#r=<path>`**. A fragment is
never sent to the server nor to the CDN, so the anonymous login page is one entry per (host,
language, cookies) and N probes cost ONE render a minute. The page carries a four-line script that
copies `#r=` into the hidden `return_url` field the OTP form, the passkey leg and the server's
`safeReturnUrl` already read — nothing changes at the POST, the anti-open-redirect check is the same.
The other `?return_url=` emitters (the OTP page's back link, `passkey/register`) keep the query: they
come after a POST or with a cookie, outside the cache anyway. Without JavaScript the field stays
empty and the visitor lands on the site root after signing in (the OTP form itself needs no script).
Pinned by `test/apphost-router-behavior/login-gate.test.ts` (one login URL for every gated path) and
`test/auth-login-return-fragment.test.ts` (the script, run against a fake DOM).

## Concurrency headroom and the scaling ladder (t_concurrency_headroom, 0.1.105)

Every Lambda in the account — the connector, its authorizers, the auth Lambda and **every tenant app
backend** — draws from ONE regional pool. The platform's own functions reserve a slice
(`lib/stack/reserved-concurrency.ts`: connector 150, front door 200, MCP authorizer 50, auth
Lambda 50 = **450**), and the account limit is **2 000** (the 400 → 2 000 raise asked on 22/09/2026
was granted; verified live on 11/10 against Service Quotas `L-B99A9384`, eu-west-1) — so **1 550**
slots stay unreserved for the apps.

**Concurrency is not the number of organisations.** It counts requests in flight at the same
instant: a thousand quiet sites cost nothing, and ordinary small-business traffic across a thousand
orgs is a few percent of the front door. What eats the margin is ONE burst — a scanner on a login
page (10/10: 29 of 50), a viral site, a tenant loop, a cron storm — and until 0.1.105 the first
instrument to notice was `Throttles >= 1`, i.e. visitors already refused.

**The headroom alarms** (`lib/stack/alarms/headroom.ts`) watch the same `ConcurrentExecutions` the
reservation caps, at **70 %** of each ceiling, `Maximum` over 5 min, 2 datapoints of 3 (a single
spike the edge cache absorbs stays quiet; a sustained climb does not). Calibrated on 14 days to
11/10: auth Lambda ≤ 40 (50 on the 06/10 incident), front door ≤ 56 (180 that day), account ≤ 82
(359 that day) — only the incident day would have fired. A function whose reservation is removed
(`none`) has no alarm of its own; the account alarm (no `FunctionName` dimension) still covers it.

**The ladder — a parameter deploy, no code.** Each reservation is `-p reservedConcurrency<Label>`
and the account limit `-p lambdaAccountConcurrency` (declared in `hereyarc.yaml`; a `-p` reaches
this package only if declared there, and the connector's `release.yml` passes each one only when
its GitHub Variable is set). The alarm thresholds derive from the figures in force, so there is no
second number to forget:

| signal | reading | move |
|---|---|---|
| a function's headroom alarm, one address in the `rate_guard` lines | a scanner | nothing to scale — the brakes of `t_login_burst_authlambda` hold it |
| a function's headroom alarm, many addresses, or repeating | growth | raise that reservation (auth Lambda 50 → 150, front door 200 → 500 are the first steps), keep the sum ≥ 100 under the account limit |
| `AccountConcurrencyHeadroomAlarm` | the tenants' pool is filling | find the function (`ConcurrentExecutions` by `FunctionName`): a loop is throttled by its org's gateway rate, a cron storm by `CRON_LIMIT`; if it is growth, ask AWS for the next tier (5 000) and set `lambdaAccountConcurrency` to the granted figure |

Beyond that (≳ 1 000 active orgs), the next step is isolation — an auth Lambda per org — and it
is a separate decision, not needed today. Pinned by `test/core-alarms/headroom.test.ts` and
`test/reserved-concurrency.test.ts`.

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

### What is alarmed (24 alarms in the production shape, 0.1.105), and why each layer needs its own

Alarms are created **unconditionally** — they stay readable in CloudWatch and other subscribers stay
possible; only the *speaking* depends on the two inputs above.

| Alarm | Threshold | The blind spot it covers |
|---|---|---|
| `Errors` + `Throttles`, per Lambda (5 functions → 10 alarms) | ≥ 1 / 5 min | the layer that throws |
| `ConcurrentExecutions` **headroom**, per reserved Lambda (4 alarms) + the whole account (1) — `*HeadroomAlarm`, `AccountConcurrencyHeadroomAlarm` (0.1.105) | Maximum ≥ **70 %** of the reservation in force (35 / 35 / 105 / 140) or of the declared account limit (1 400 of 2 000), 2 of 3 five-minute windows | a reservation is also a **cap**, and `Throttles` rings once visitors are already refused: on 06/10 the auth Lambda sat at 50/50 with no signal before. The thresholds derive from the deploy params, so raising a reservation moves its alarm. The account one has **no dimension** — it is the only alarm that sees the tenants' shared pool |
| `HttpApiPlatform5xx` (metric math: `HttpApi5xx - HttpApi5xxTenantApp - HttpApi5xxUpstream`) | ≥ 1 / 5 min | a 502/504 at the **gateway** never makes the Lambda throw, so `AWS/Lambda Errors` reads 0 |
| `AppStateTable` `SystemErrors` + `ThrottledRequests` | ≥ 1 / 5 min | a throttled state write is neither a Lambda error nor a gateway error |
| `McpRefusals` (`Mcp403`: access-log `403` on path `/mcp`, **fresh only** — `refusal = "fresh"`; `stale` (hourly retry on a token dead 2 h+) and `probe` (no `Authorization` header at all, on the plugin host — the discovery probe every MCP client starts with, 0.1.102) are not counted; a client retrying hourly on a token `expired` for 2 h+ is counted apart in `Mcp403Stale`, no alarm) | ≥ 5 / 15 min | a **refusal** is not an error, a 5xx or a throttle: on 2026-09-21 `/mcp` answered 403 to almost everyone for ~2 h (188 refusals) and nothing rang. Baseline over the 7 days before: **zero**. Counted on the access log because the gateway caches a refusal 5 min — the authorizer does not even run. WHY each one was refused: `mcp_authorizer_refused` lines (`reason`) in the McpAuthorizer log group — never the token, claims only once the signature held |

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

Three metric filters over the access log answer "whose?", and the alarm is the first minus the other two:

| Metric (`Dilaya/Connector`) | Filter pattern | Meaning |
|---|---|---|
| `HttpApi5xx` | `{ $.status = "5*" }` | every 5xx the gateway served |
| `HttpApi5xxTenantApp` | `{ $.status = "5*" && $.integrationStatus = "200" && $.routeKey = "*/site*" }` | the tenant's own app answered 500 |
| `HttpApi5xxUpstream` | `{ ($.status = "502" \|\| $.status = "504") && $.integrationStatus = "200" && $.integrationErrorMessage = "-" && ($.routeKey = "ANY /o/{orgId}/{app}/mcp/{proxy+}" \|\| $.routeKey = "ANY /mcp-connections/{proxy+}") }` | the connector answered 502/504 on purpose because a THIRD PARTY failed (outbound MCP gateway, OAuth consent page) |

Both signals are required. `integrationStatus = 200` alone would also swallow **our** handler's own
500s (they answer normally too) — trading a noisy alarm for a blind one; the `…/site…` route keys are
the only ones wired straight to an `app-app-*` Lambda. Values are matched as **strings**, because
that is how the access log writes them (`"status":"500"`) — a numeric comparison matches nothing and
leaves an alarm that looks healthy and never fires. Both filters carry `DefaultValue: 0`, without
which a period with no tenant 5xx has no datapoint and the subtraction is *dropped* rather than
evaluated. The two filters read the **same** log events on purpose: pairing one with the gateway's
own metric would let ingestion skew invent a difference across a period boundary.

**A third party's failure is not ours either** (t_gw_upstream_5xx, 0.1.77). On 2026-09-03 two slow
Pilote freebusy answers through the outbound MCP gateway, and on 2026-09-09 a target's OAuth server
failing discovery on the consent page, both fired this alarm while the connector worked and said so.
On those two routes the connector answers 502 (upstream error) / 504 (upstream timeout) ONLY for a
third party — its `gatewayFailureStatus` keeps its own bugs at 500, which stay counted.
`integrationErrorMessage = "-"` keeps a gateway-made 502 (a malformed Lambda response, which also
carries `int=200`) on our side. The pattern was run through `aws logs test-metric-filter` on 8
shapes plus the real 17/09 and 09/09 lines. The org is told by its own incident fiche, so this
metric is not alarmed.

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

## The sweep tick — housekeeping off the request path (0.1.103)

`lib/stack/sweep-tick.ts` adds one EventBridge rule, `rate(5 minutes)`, whose only target is the
connector itself, invoked with the bare envelope `{"__dilaya":"sweep"}` (same shape as the alarm
envelope: no org, no app, no sweep name — there is no field a caller could steer at a tenant). The
connector branches on the marker (`src/handler/sweep-envelope.ts`, 0.1.358) and runs its six
housekeeping sweeps — runtime-layer propagation, the edge host map, edge usage, cron suspension,
stalled custom domains, the one-time auth-route heal — in THAT invocation and in no other.

Until then every sweep was `await`ed at the top of **every** invocation: each claims a DynamoDB
window, and the one request that **won** the claim ran the work inline, before its own answer —
measured 2026-10-10 at 8 072 ms on the landing's billing tick, with the host-map floor check and an
edge-usage read on the same request (t_floor_syncs_offpath). The DynamoDB claims are unchanged (a
tick may lose one to a previous tick still holding the window — the normal case); the rule exists on
every deployment shape (a sweep whose feature is off returns at once); the grant it adds is a
**resource policy** for `events.amazonaws.com`, not a statement on the connector role, so the
role's statement order is untouched. `test/sweep-tick.test.ts` pins the cadence, the target, the
bare envelope and the permission.

## Regional pods: `originDomain` + `skipGlobalResources` (t_rca_p0_infra, 0.1.117)

Région Canada runs a second full pod (ca-central-1) next to Ireland, both behind the **same**
public URL `app.dilaya.eu/mcp`; a front door (P1) routes each org to its pod's origin. Two
optional inputs (`lib/stack/pod-topology.ts`) prepare that. **Absent, the template is byte-identical
to 0.1.116** (golden profiles a–d unchanged, plus a prod-like synth).

- **`originDomain`** (e.g. `ca.app.dilaya.eu`): the only API Gateway custom domain + Route 53 record
  the pod creates (in the `customDomain` zone; `wildcardCertificateArn` must be a cert **of the
  pod's region** covering it — `*.dilaya.eu` does not cover a two-label name like
  `ca.app.dilaya.eu`). `customDomain` and `mcp.<zone>` stay what the pod **accepts and advertises**:
  authorizer audience, PRM `resource`, the connector's `customDomain`/`MCP_DOMAIN` env, the
  `POST /` plugin route, and — on a primary pod only — the per-app Lambda prefix (`app-app-`). The pod creates **neither** public
  domain nor public record (they belong to the front door). The app-content edge, if enabled, fronts
  `originDomain`. Output `OriginUrl`.
- **`skipGlobalResources=true`**: a secondary pod. Requires `originDomain`; skips the legacy
  `*.<customDomain>` frontend distribution; refuses `appContentDomain` / `filesDomain` at synth; and
  takes its per-app name prefix from `originDomain`'s first label (`app-ca.dilaya.eu` → `app-ca-app-`,
  0.1.121), since that prefix names **account-global IAM roles** the connector creates at runtime
  (`<prefix>role-shared`, `<prefix>role-<o8>-<a8>`): on `app-app-` the CA pod's first `deploy-backend`
  would `PutRolePolicy` over the EU shared role. An `originDomain` whose first label is the public one
  (`app.ca.dilaya.eu`) is refused at synth.

Once-per-account resources a second pod must **not** recreate, and how it avoids them:

| Resource (created by the primary pod) | Why once per account | Pod 2 |
|---|---|---|
| `app.dilaya.eu` API-GW domain + A record | one DNS name | `originDomain` |
| `mcp.<zone>` plugin host domain + A record | one DNS name | `originDomain` (not owned) |
| App-content edge: CloudFront `*.dilaya-apps.eu` + wildcard A/AAAA + `_dmarc` TXT, CF Function `app-app-apphost-router` (global name), KVS, static bucket/OAC, edge log bucket, cache/origin-request policies, BYOD IAM, Route 53 Domains IAM (global API), `ByodOriginRestamp` trigger (rewrites every `dilaya:byod` distribution) | global CloudFront names/aliases, one DNS name, account-wide side effects | don't set `appContentDomain` (refused with the flag) |
| Files domain: CloudFront `files.dilaya.eu` + A/AAAA | one alias / DNS name | don't set `filesDomain` (refused with the flag) |
| Runtime IAM roles named from `APP_LAMBDA_NAME_PREFIX` (`<prefix>role-shared` + its inline policy, `<prefix>role-<o8>-<a8>`, the `role-migrate` orphan sweep) | IAM names are account-global | prefix from `originDomain` (`app-ca-app-`) |
| Legacy frontend distribution `*.<customDomain>` + us-east-1 `DnsValidatedCertificate` + CF Function `<stack>-subdomain-rewrite` + wildcard record (only with Cognito env; not in prod today) | global alias / names | skipped by the flag |

Everything else is regional (Lambdas, HTTP API, DynamoDB, SSM, Secrets, Scheduler group, alarms,
IAM roles with CloudFormation-generated names) and is simply built again in the second region.
The viewer host is forwarded by the region router (next section); the app-content edge / BYOD
distributions still need per-org origin routing.

## Region router: one public URL in front of every pod (t_rca_p1_router, 0.1.118)

The front door of Région Canada (`lib/stack/region-router/`). **Off unless `regionRouter=true`;
absent, the template is byte-identical to 0.1.117** (golden a–e + the release.yml synth).

- **CloudFront distribution** for `customDomain` + `mcp.<zone>` (cert `regionRouterCertArn`,
  us-east-1). Default origin = the HOME pod (first of `regionRouterOrigins`), HTTPS only, every
  method, no cache, all viewer headers but Host (`Authorization` included), and the origin header
  `x-dilaya-region-verify: <regionRouterOriginSecret>`. **No DNS record**: pointing the public names
  at it is the cutover (explicit GO), after the pod serves its own `originDomain`.
- **Viewer-request CloudFront Function** `<prefix>region-router` + **KVS** (org id → region, starts
  EMPTY = everyone home). Decodes the bearer's `org_ids` for ROUTING only (no signature check; the
  pod's authorizer and its own-region check still decide), reads ≤ 16 orgs, and swaps only the origin
  `domainName` (the secret header is inherited). `/o/<orgId>/…` routes on the path's org. It always
  sets `x-dilaya-viewer-host` (the viewer's Host) and `x-dilaya-route` (`path`/`token`/`body`/`home`),
  overwriting anything a viewer sent.
- **Lambda@Edge** (origin-request, body included) for `route=body` only — a bearer whose orgs sit in
  different regions: `params.arguments.org` of the JSON-RPC message (a batch must agree), routed only
  to a region the viewer function listed for that org; no org / unknown / > 1 MiB / truncated /
  unparseable → home. It lives in **its own us-east-1 stack** (`edge-stack.ts`,
  `bin/region-router-edge.ts`) and its version ARN comes in as `regionRouterEdgeVersionArn`: hereya
  runs `cdk deploy` with no stack selector, which a second (`EdgeFunction`) stack would break.
- **Pod trust** (`pod-trust.ts`): with `regionRouterOriginSecret` — set it on EVERY pod behind the
  router — the connector (`REGION_ROUTER_ORIGIN_SECRET`) and the PRM honour `x-dilaya-viewer-host`
  only on a request whose `x-dilaya-region-verify` equals it (constant-time). Without it, ignored.
  A separate secret from `appContentOriginSecret`, which would unlock the origin-locked site routes.

The two edge programs are executed by `test/region-router/` (lifted from the synthesized templates).

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

`npx ts-node --prefer-ts-exts scripts/synth-golden.ts <dir>` synthesizes the stack under six env
profiles — minimal, custom domain + Cognito + runtime layer, the full production shape, the
same features with every optional sub-feature off, a secondary regional pod, and a primary pod
behind its region router — and writes one template JSON per profile. Run
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
