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

## Build & ship

CDK (`iac: cdk`). It **synths from TypeScript via ts-node** (`cdk.json` → `npx ts-node --prefer-ts-exts
bin/…ts`), so **edit the `.ts` under `lib/` — the committed `.js` is vestigial** (gitignored build
output). No CI in this repo: publish a new version by bumping `hereyarc.yaml`, committing, pushing,
and running `hereya publish`. The connector's `hereya.yaml` pins the version; to roll a change to
prod, publish here, bump that pin, then do a `dilaya/connector` release (on an explicit deploy GO).

```bash
npm run build   # tsc (typecheck; the .js it emits is not shipped)
```
