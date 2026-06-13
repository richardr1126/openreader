---
title: Environment Variables
toc_max_heading_level: 3
---

This page is the source-of-truth reference for OpenReader environment variables.

:::note Recommended configuration path
Use **Settings → Admin** as the primary source of truth for shared providers and runtime site features.
`API_BASE` / `API_KEY` are optional one-time provider bootstrap seeds.
Runtime site features are seeded with `RUNTIME_SEED_JSON` / `RUNTIME_SEED_JSON_PATH`.
:::

## Quick Reference Table

| Variable | Area | Default | When to set |
| --- | --- | --- | --- |
| `LOG_FORMAT` | Runtime logging | `pretty` | Set `json` for structured logs |
| `LOG_LEVEL` | Runtime logging | `info` | Set app server log level |
| `API_BASE` | TTS provider bootstrap seed | unset | Optional first-boot base URL for `default-openai` |
| `API_KEY` | TTS provider bootstrap seed | unset | Optional first-boot API key for `default-openai` |
| `BASE_URL` | Auth | unset | Required at startup |
| `AUTH_SECRET` | Auth | unset | Required at startup |
| `AUTH_TRUSTED_ORIGINS` | Auth | empty | Add extra allowed origins |
| `USE_ANONYMOUS_AUTH_SESSIONS` | Auth | `false` | Set `true` to allow anonymous auth sessions |
| `GITHUB_CLIENT_ID` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_SECRET` to enable GitHub sign-in |
| `GITHUB_CLIENT_SECRET` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_ID` to enable GitHub sign-in |
| `ADMIN_EMAILS` | Admin | empty | Comma-separated emails auto-promoted to admin |
| `CRON_SECRET` | Scheduled tasks | unset | Required for Vercel cron invocations |
| `POSTGRES_URL` | Database | unset (SQLite mode) | Set to switch metadata/auth DB to Postgres |
| `USE_EMBEDDED_WEED_MINI` | Storage | `true` when unset | Set `false` to use external S3-compatible storage only |
| `WEED_MINI_DIR` | Storage | `docstore/seaweedfs` | Override embedded SeaweedFS data directory |
| `WEED_MINI_WAIT_SEC` | Storage | `20` | Tune SeaweedFS startup wait timeout |
| `S3_ACCESS_KEY_ID` | Storage | auto-generated in embedded mode | Set explicitly for stable/external credentials |
| `S3_SECRET_ACCESS_KEY` | Storage | auto-generated in embedded mode | Set explicitly for stable/external credentials |
| `S3_BUCKET` | Storage | `openreader-documents` in embedded mode | Required for external S3-compatible storage |
| `S3_REGION` | Storage | `us-east-1` in embedded mode | Required for external S3-compatible storage |
| `S3_ENDPOINT` | Storage | derived in embedded mode | Set for S3-compatible providers (MinIO/SeaweedFS/R2/etc.) |
| `S3_FORCE_PATH_STYLE` | Storage | `true` in embedded mode | Set per provider requirement |
| `S3_PREFIX` | Storage | `openreader` | Customize object key prefix |
| `IMPORT_LIBRARY_DIR` | Library import | `docstore/library` fallback | Set a single server library root |
| `IMPORT_LIBRARY_DIRS` | Library import | unset | Set multiple roots (comma/colon/semicolon separated) |
| `EMBEDDED_COMPUTE_WORKER_PORT` | Compute | `8081` | Override embedded worker bind port |
| `EMBEDDED_NATS_PORT` | Compute | `4222` | Override embedded NATS client port |
| `EMBEDDED_NATS_MONITOR_PORT` | Compute | `8222` | Override embedded NATS monitor port |
| `EMBEDDED_NATS_STORE_DIR` | Compute | `docstore/nats/jetstream` | Override embedded JetStream storage directory |
| `NATS_URL` | Compute | `nats://127.0.0.1:4222` in embedded startup | Override embedded startup or set standalone worker URL |
| `COMPUTE_LOG_LEVEL` | Compute | `info` | Compute worker log level |
| `COMPUTE_JOB_CONCURRENCY` | Compute | `1` | Shared compute concurrency cap |
| `COMPUTE_WHISPER_TIMEOUT_MS` | Compute | `30000` | Whisper alignment timeout budget |
| `COMPUTE_PDF_TIMEOUT_MS` | Compute | `300000` | PDF parse timeout budget |
| `COMPUTE_PDF_JOB_ATTEMPTS` | Compute | `1` | Max JetStream deliveries for PDF layout jobs |
| `COMPUTE_OP_STALE_MS` | Compute | `max(30m, 4x max compute timeout)` | Shared stale window for compute op replacement |
| `WHISPER_MODEL_BASE_URL` | Compute model source | onnx-community default | Override Whisper ONNX model base URL |
| `PDF_LAYOUT_MODEL_BASE_URL` | Compute model source | PP-DocLayoutV3 default | Override PDF layout ONNX model base URL |
| `COMPUTE_WORKER_URL` | External compute mode | unset | Set only for standalone external worker mode |
| `COMPUTE_WORKER_TOKEN` | External compute mode | unset | Required for standalone external worker auth |
| `FFMPEG_BIN` | Audio runtime | auto-detected (`ffmpeg-static`) | Override ffmpeg binary path |
| `DISABLE_AUTH_RATE_LIMIT` | Auth request throttling | `false` | Set `true` to disable Better Auth request rate limiting |
| `ENABLE_TEST_NAMESPACE` | Testing/CI | unset | Honor `x-openreader-test-namespace` header in production builds |
| `RUN_DRIZZLE_MIGRATIONS` | DB migrations | `true` | Set `false` to skip startup Drizzle migrations |
| `RUN_FS_MIGRATIONS` | Storage migrations | `true` | Set `false` to skip startup filesystem -> S3/DB migration pass |
| `RUNTIME_SEED_JSON_PATH` | Runtime JSON seed | unset | Absolute path to first-boot JSON seed document |
| `RUNTIME_SEED_JSON` | Runtime JSON seed | unset | Inline first-boot JSON seed document |

## Runtime Logging

### LOG_FORMAT

Controls log output format for server-side Pino loggers.

- Default: `pretty`
- Allowed values: `pretty`, `json`
- Applies to app server and compute worker

### LOG_LEVEL

App server log level.

- Default: `info`

## TTS Provider and Request Behavior

### API_BASE

Optional first-boot bootstrap base URL for the auto-created `default-openai` shared provider.

- Example: `http://host.docker.internal:8880/v1`
- Read only for provider bootstrap when shared providers are empty. Setting `API_BASE` is sufficient; `API_KEY` may be blank.
- After bootstrap, provider configuration is DB-backed and managed in **Settings → Admin → Shared providers**.

### API_KEY

Optional first-boot bootstrap API key for the auto-created `default-openai` shared provider.

- Read only for provider bootstrap when shared providers are empty.
- Stored encrypted at rest after bootstrap.
- After bootstrap, provider configuration is DB-backed and managed in **Settings → Admin → Shared providers**.

## Auth and Identity

### BASE_URL

Required external base URL for this OpenReader instance.

- Required at startup
- Example: `http://localhost:3003` or `https://reader.example.com`

### AUTH_SECRET

Required secret key used by auth/session handling.

- Required at startup
- Generate with `openssl rand -base64 32`

### AUTH_TRUSTED_ORIGINS

Additional allowed origins for auth requests.

- Comma-separated list
- `BASE_URL` origin is trusted automatically

### USE_ANONYMOUS_AUTH_SESSIONS

Controls whether auth-enabled deployments can create/use anonymous sessions.

- Default: `false`

### GITHUB_CLIENT_ID

GitHub OAuth client ID.

- Set with `GITHUB_CLIENT_SECRET`

### GITHUB_CLIENT_SECRET

GitHub OAuth client secret.

- Set with `GITHUB_CLIENT_ID`

### ADMIN_EMAILS

Comma-separated list of email addresses auto-promoted to admin.

- Requires auth to be enabled
- Admins can manage shared providers and runtime site features in-app

### CRON_SECRET

Bearer-token secret for `GET /api/admin/tasks/tick`.

- Required on Vercel so scheduled maintenance tasks can run from the configured Vercel Cron.
- Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on cron invocations.
- Generate a strong random value, for example with `openssl rand -base64 32`.
- Self-hosted Node.js deployments run the scheduler in-process and do not require this variable.

## Database and Object Blob Storage

### POSTGRES_URL

Switches metadata/auth storage from SQLite to Postgres.

- Unset: SQLite at `docstore/sqlite3.db`
- Set: Postgres mode

### USE_EMBEDDED_WEED_MINI

Controls embedded SeaweedFS startup.

- Default behavior: treated as enabled when unset
- Set `false` to rely on external S3-compatible storage

### WEED_MINI_DIR

Data directory for embedded SeaweedFS (`weed mini`).

- Default: `docstore/seaweedfs`

### WEED_MINI_WAIT_SEC

Max wait time for embedded SeaweedFS startup.

- Default: `20`

### S3_ACCESS_KEY_ID

S3 access key.

- Optional in embedded mode (auto-generated when unset)
- Required for external S3 mode

### S3_SECRET_ACCESS_KEY

S3 secret key.

- Optional in embedded mode (auto-generated when unset)
- Required for external S3 mode

### S3_BUCKET

S3 bucket name.

- Embedded default: `openreader-documents`
- Required for external S3 mode

### S3_REGION

S3 region.

- Embedded default: `us-east-1`
- Required for external S3 mode

### S3_ENDPOINT

Custom endpoint for S3-compatible providers.

- Optional for AWS
- Typical for MinIO/SeaweedFS/R2

### S3_FORCE_PATH_STYLE

Force path-style S3 URLs.

- Embedded default: `true`

### S3_PREFIX

Object key prefix.

- Default: `openreader`

## Library Import

### IMPORT_LIBRARY_DIR

Single library source directory.

### IMPORT_LIBRARY_DIRS

Multiple library roots.

- Supports comma, colon, or semicolon-separated values

## Compute Worker and Model Configuration

### EMBEDDED_COMPUTE_WORKER_PORT

Embedded compute worker port.

- Default: `8081`

### EMBEDDED_NATS_PORT

Embedded NATS client port.

- Default: `4222`

### EMBEDDED_NATS_MONITOR_PORT

Embedded NATS monitor port.

- Default: `8222`

### EMBEDDED_NATS_STORE_DIR

Embedded NATS JetStream data directory.

- Default: `docstore/nats/jetstream`

### NATS_URL

NATS URL used by compute services.

- Embedded startup default: `nats://127.0.0.1:4222`

### COMPUTE_LOG_LEVEL

Compute worker log level.

- Default: `info`

### COMPUTE_JOB_CONCURRENCY

Max concurrent compute jobs per worker.

- Default: `1`

### COMPUTE_WHISPER_TIMEOUT_MS

Whisper alignment timeout budget.

- Default: `30000`

### COMPUTE_PDF_TIMEOUT_MS

PDF parse timeout budget.

- Default: `300000`

### COMPUTE_PDF_JOB_ATTEMPTS

Max JetStream deliveries for PDF layout jobs.

- Default: `1`
- In embedded worker mode, set this in the root `.env`

### COMPUTE_OP_STALE_MS

Stale operation window before worker/app cleanup logic can replace an op.

- Default: `max(30m, 4x max compute timeout)`

### WHISPER_MODEL_BASE_URL

Base URL for Whisper ONNX model downloads.

### PDF_LAYOUT_MODEL_BASE_URL

Base URL for PDF layout model downloads.

### COMPUTE_WORKER_URL

External compute worker URL.

- Leave unset for embedded worker mode

### COMPUTE_WORKER_TOKEN

Shared token for app-to-external-worker requests.

## Audio Runtime

### FFMPEG_BIN

Override ffmpeg binary path used for audio processing.

- Used by audiobook processing routes and compute worker Whisper audio decode.

## Testing and CI

### DISABLE_AUTH_RATE_LIMIT

Disables Better Auth request rate limiting.

- Default: `false`

### ENABLE_TEST_NAMESPACE

Enables the `x-openreader-test-namespace` header path in production builds.

## Migration Controls

### RUN_DRIZZLE_MIGRATIONS

Controls startup Drizzle schema migrations.

- Default: `true`
- Set `false` to skip startup migration run

### RUN_FS_MIGRATIONS

Controls startup filesystem-to-S3/DB migration pass.

- Default: `true`
- Set `false` to skip startup storage migration run

## Runtime JSON Seed (v4)

### RUNTIME_SEED_JSON_PATH

Path-based first-boot seed document.

- If both `RUNTIME_SEED_JSON_PATH` and `RUNTIME_SEED_JSON` are set, path wins.
- Value must point to a JSON file readable by the app process.

### RUNTIME_SEED_JSON

Inline first-boot seed document.

- Used only when `RUNTIME_SEED_JSON_PATH` is unset.
- Must be a JSON object with `version: 1`.

Supported top-level keys:

- `version` (required, must be `1`)
- `runtimeConfig` (optional object, strict-validated against runtime schema)
- `providers` (optional array of shared provider seed entries)

Example:

```json
{
  "version": 1,
  "runtimeConfig": {
    "enableUserSignups": true,
    "restrictUserApiKeys": true,
    "defaultTtsProvider": "custom-openai",
    "enableTtsProvidersTab": true,
    "enableAudiobookExport": true,
    "enableDocxConversion": true,
    "showAllProviderModels": true,
    "disableTtsRateLimit": true,
    "ttsDailyLimitAnonymous": 50000,
    "ttsDailyLimitAuthenticated": 500000,
    "ttsIpDailyLimitAnonymous": 100000,
    "ttsIpDailyLimitAuthenticated": 1000000,
    "ttsCacheMaxSizeBytes": 268435456,
    "ttsCacheTtlMs": 1800000,
    "ttsUpstreamMaxRetries": 2,
    "ttsUpstreamTimeoutMs": 285000,
    "disableComputeRateLimit": true,
    "computeParseBurstMax": 8,
    "computeParseBurstWindowSec": 60,
    "computeParseSustainedMax": 24,
    "computeParseSustainedWindowSec": 600,
    "maxUploadMb": 200,
    "changelogFeedUrl": "https://docs.openreader.richardr.dev/changelog/manifest.json"
  },
  "providers": [
    {
      "slug": "default-openai",
      "displayName": "Default (seeded)",
      "providerType": "custom-openai",
      "baseUrl": "http://localhost:8880/v1",
      "defaultModel": "kokoro",
      "enabled": true
    }
  ]
}
```

Provider fallback behavior:

- If the JSON seed includes `providers` (including an empty array), `API_BASE` / `API_KEY` fallback is skipped.
- If the JSON seed does not include a `providers` key, the legacy `API_BASE` / `API_KEY` bootstrap fallback can still create `default-openai` when provider rows are empty. `API_BASE` alone is sufficient for an upstream that does not require authentication.

Precedence summary:

- Runtime reads: admin DB runtime rows override built-in defaults.
- Seed input (`RUNTIME_SEED_JSON*`) only populates missing runtime rows on first boot; it does not overwrite existing/admin-edited rows.
- Provider bootstrap order: JSON `providers` section > `API_BASE`/`API_KEY` fallback > no provider bootstrap.

## Related

- [Admin Panel](../configure/admin-panel)
- [TTS Providers](../configure/tts-providers)
- [Local Development](../deploy/local-development)
- [Vercel Deployment](../deploy/vercel-deployment)
