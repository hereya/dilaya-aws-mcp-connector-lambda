# hereya-aws-mcp-app-lambda

Deploys a Lambda function behind its own HTTP API Gateway v2 with **per-org OAuth authorization** and optional subdomain routing. Designed as the per-app provisioning package (Stack 4) in a multi-tenant platform.

Database access, S3 access, and other infrastructure dependencies are provided by separate Hereya packages. Their outputs (IAM policies, connection strings, bucket names, etc.) arrive via `hereyaProjectEnv` and are automatically injected into the Lambda.

## Architecture

```
                  julie-recipes.hereya.app
                           |
                           v
              ┌────────────────────────┐
              │   Per-App HTTP API      │
              │                         │
              │   /{proxy+} ───────────┼──> App Lambda
              │   /         ───────────┼──> App Lambda
              │                         │
              │   OAuth Authorizer      │
              │   (JWT + org binding)   │
              └────────────────────────┘

    hereyaProjectEnv provides:
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ iamPolicy*   │  │ secret://*   │  │ plain vars   │
    │ -> IAM role  │  │ -> Secrets   │  │ -> env vars  │
    │   policies   │  │   Manager    │  │              │
    └──────────────┘  └──────────────┘  └──────────────┘
```

## AWS Resources Created

- **Lambda Function** -- App code from `{hereyaProjectRootDir}/dist`, Node.js 22.x runtime
- **Authorizer Lambda** -- JWT validator that checks token signature, expiry, issuer, and org_id binding
- **HTTP API** (API Gateway v2) -- Per-app API with catch-all routes protected by the authorizer
- **Secrets Manager Secrets** -- For any `secret://` prefixed values in hereyaProjectEnv
- **Custom Domain** (optional) -- Subdomain using wildcard cert from Stack 3
- **Route53 A Record** (optional) -- DNS alias for the custom subdomain

## Inputs

Configuration is provided via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `hereyaProjectRootDir` | **Yes** | -- | Path to app code. Lambda loads from `{path}/dist`. |
| `oauthServerUrl` | **Yes** | -- | Hereya Cloud OAuth server URL for JWT validation (JWKS endpoint). |
| `organizationId` | **Yes** | -- | Organization ID. The authorizer rejects JWTs whose `org_id` claim doesn't match. |
| `hereyaProjectEnv` | No | `"{}"` | JSON string of environment variables from dependency packages. Supports three types (see below). |
| `customDomain` | No | -- | Full subdomain for the app, e.g., `julie-recipes.hereya.app`. |
| `customDomainZone` | No | auto-extracted | Base domain zone for Route53 lookup, e.g., `hereya.app`. Auto-extracted from `customDomain` if not provided. |
| `wildcardCertificateArn` | No* | -- | ACM wildcard certificate ARN from Stack 3. **Required when `customDomain` is set.** |
| `memorySize` | No | `256` | Lambda memory in MB. |
| `timeout` | No | `30` | Lambda timeout in seconds. |
| `handler` | No | `handler.handler` | Lambda handler (file.function format). |

### hereyaProjectEnv Variable Types

The `hereyaProjectEnv` JSON string is automatically populated by Hereya from dependency package outputs. Variables are processed into three categories:

| Type | Detection | Handling |
|------|-----------|----------|
| **IAM Policies** | Key starts with `iamPolicy` or `IAM_POLICY_` | Parsed as JSON IAM policy document. Each statement is attached to the Lambda's execution role. |
| **Secrets** | Value starts with `secret://` | Stored in Secrets Manager as `/{stackName}/{key}`. Lambda receives the secret **name** (not value) as env var. Lambda is granted `secretsmanager:GetSecretValue`. A `SECRET_KEYS` env var lists all secret keys (comma-separated). |
| **Plain** | Everything else | Passed directly as Lambda environment variables. |

**Example hereyaProjectEnv:**

```json
{
  "iamPolicyAwsS3Bucket": "{\"Version\":\"2012-10-17\",\"Statement\":[...]}",
  "iamPolicyAuroraDataApi": "{\"Version\":\"2012-10-17\",\"Statement\":[...]}",
  "bucketName": "platform-my-stack",
  "clusterArn": "arn:aws:rds:us-east-1:123:cluster:abc",
  "masterSecretArn": "secret://arn:aws:secretsmanager:...",
  "DATABASE_URL": "secret://postgresql://user:pass@host/db"
}
```

## Outputs

| Output | Description | Example Value |
|--------|-------------|---------------|
| `ServiceUrl` | The app's URL. Custom domain HTTPS URL if configured, otherwise the API Gateway endpoint. | `https://julie-recipes.hereya.app` |

## Usage with Hereya

### Basic deployment

```bash
hereya deploy hereya/aws-mcp-app-lambda \
  -p oauthServerUrl=https://auth.hereya.app \
  -p organizationId=org_abc123
```

### With custom domain (using Stack 3 outputs)

```bash
hereya deploy hereya/aws-mcp-app-lambda \
  -p oauthServerUrl=https://auth.hereya.app \
  -p organizationId=org_abc123 \
  -p customDomain=julie-recipes.hereya.app \
  -p wildcardCertificateArn=arn:aws:acm:us-east-1:123:certificate/abc
```

### With dependency packages

In a project's `hereya.yaml`:

```yaml
deploy:
  hereya/aws-mcp-app-lambda:
    version: 0.1.0
packages:
  hereya/aws-aurora-dataapi:
    version: 0.1.0
  hereya/aws-s3-shared:
    version: 0.1.0
```

The outputs from `aws-aurora-dataapi` (clusterArn, masterSecretArn, iamPolicyAuroraDataApi) and `aws-s3-shared` (bucketName, bucketArn, iamPolicyAwsS3Bucket) are automatically injected into `hereyaProjectEnv`.

## OAuth Authorization

Every request to the app Lambda is authenticated via a Lambda authorizer that:

1. Extracts the Bearer token from the `Authorization` header
2. Fetches the JWKS from `{oauthServerUrl}/.well-known/jwks.json` (cached for 1 hour)
3. Verifies the RS256 JWT signature
4. Checks token expiration
5. Validates the issuer matches `oauthServerUrl`
6. Verifies `org_id` claim matches the configured `organizationId`

On success, the authorizer passes `userId`, `orgId`, and `orgRole` in the request context, available to the app Lambda via `event.requestContext.authorizer.lambda.*`.

Authorization results are cached at the API Gateway level for 5 minutes per token.

## Custom Domain Setup

This package reuses the wildcard ACM certificate from the shared API Gateway package (Stack 3, `hereya/aws-apigateway`). Each app gets:

1. A specific `DomainName` (e.g., `julie-recipes.hereya.app`) using the shared wildcard cert
2. An `ApiMapping` connecting the subdomain to this app's HttpApi
3. A Route53 A record (alias) for the subdomain

Route53 resolves specific records over wildcard records, so the per-app record takes priority over Stack 3's wildcard.

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run watch    # Watch mode
npx cdk synth    # Synthesize CloudFormation template
npx cdk deploy   # Deploy stack
```
