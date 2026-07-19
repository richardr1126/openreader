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

All OpenReader configuration variables are server-only; none are exposed through a `NEXT_PUBLIC_` browser variable. "App" includes the bootstrap process and embedded worker it starts. Standalone-worker rows must be set on the worker service itself.

| Variable | Owner / runtime | Default and validation | When to set |
| --- | --- | --- | --- |
| `LOG_FORMAT` | Runtime logging | `pretty` | Set `json` for structured logs |
| `LOG_LEVEL` | Runtime logging | `info` | Set app server log level |
| `API_BASE` | TTS provider bootstrap seed | unset | Optional first-boot base URL for `default-openai` |
| `API_KEY` | TTS provider bootstrap seed | unset | Optional first-boot API key for `default-openai` |
| `BASE_URL` | Auth | unset | Required at startup |
| `AUTH_SECRET` | App auth + worker provider credentials | unset | Required on the app; standalone workers must use the same value |
| `AUTH_TRUSTED_ORIGINS` | Auth | empty | Add extra allowed origins |
| `USE_ANONYMOUS_AUTH_SESSIONS` | Auth | `false` | Set `true` to allow anonymous auth sessions |
| `GITHUB_CLIENT_ID` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_SECRET` to enable GitHub sign-in |
| `GITHUB_CLIENT_SECRET` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_ID` to enable GitHub sign-in |
| `ADMIN_EMAILS` | Admin | empty | Comma-separated emails auto-promoted to admin |
| `CRON_SECRET` | Scheduled tasks | unset | Required for Vercel cron invocations |
| `RICHARDRDEV_PRODUCTION` | Official hosted instance | `false`; enabled only by exact `true` | Enables the official-instance label, privacy notice, and US region gate |
| `POSTGRES_URL` | Database | unset (SQLite mode) | Set to switch metadata/auth DB to Postgres |
| `USE_EMBEDDED_WEED_MINI` | Storage | `true` when unset | Set `false` to use external S3-compatible storage only |
| `WEED_MINI_DIR` | Storage | `docstore/seaweedfs` | Override embedded SeaweedFS data directory |
| `WEED_MINI_WAIT_SEC` | Storage | `20` | Tune SeaweedFS startup wait timeout |
| `WEED_MINI_BIND_HOST` | Storage | `127.0.0.1` | Override embedded SeaweedFS bind interface |
| `WEED_MINI_ADVERTISE_HOST` | Storage | bind host or detected private host | Override the host embedded SeaweedFS advertises |
| `WEED_MINI_PORT` | Storage | `8333` | Override embedded SeaweedFS S3 port |
| `S3_ACCESS_KEY_ID` | Storage | auto-generated in embedded mode | Set explicitly for stable/external credentials |
| `S3_SECRET_ACCESS_KEY` | Storage | auto-generated in embedded mode | Set explicitly for stable/external credentials |
| `S3_BUCKET` | Storage | `openreader-documents` in embedded mode | Required for external S3-compatible storage |
| `S3_REGION` | Storage | `us-east-1` in embedded mode | Required for external S3-compatible storage |
| `S3_INTERNAL_ENDPOINT` | Storage | `http://127.0.0.1:8333` embedded | Private S3 endpoint for app and worker traffic |
| `S3_PUBLIC_ENDPOINT` | Storage | — | Public HTTPS S3 endpoint for browser presigned transfers |
| `S3_BROWSER_TRANSPORT` | Storage | `auto` | Browser transfer mode: `auto`, `proxy`, or `presigned` |
| `S3_ENDPOINT` | Storage | deprecated | Compatibility alias; replace with explicit internal/public endpoints |
| `S3_FORCE_PATH_STYLE` | Storage | `true` in embedded mode | Set per provider requirement |
| `S3_PREFIX` | Storage | `openreader` | Customize object key prefix |
| `IMPORT_LIBRARY_DIRS` | App library import | `docstore/library` fallback | Set one or more roots (comma/colon/semicolon separated) |
| `EMBEDDED_COMPUTE_WORKER_PORT` | Compute | `8081` | Override embedded worker bind port |
| `EMBEDDED_NATS_PORT` | Compute | `4222` | Override embedded NATS client port |
| `EMBEDDED_NATS_MONITOR_PORT` | Compute | `8222` | Override embedded NATS monitor port |
| `EMBEDDED_NATS_STORE_DIR` | Compute | `docstore/nats/jetstream` | Override embedded JetStream storage directory |
| `NATS_URL` | Compute | `nats://127.0.0.1:4222` in embedded startup | Override embedded startup or set standalone worker URL |
| `NATS_CREDS` | Standalone worker | unset | Raw NATS credentials; mutually exclusive in practice with `NATS_CREDS_FILE` |
| `NATS_CREDS_FILE` | Standalone worker | unset | Path to a NATS credentials file |
| `COMPUTE_LOG_LEVEL` | Compute | `info` | Compute worker log level |
| `COMPUTE_WORKER_HOST` | Compute worker HTTP | `127.0.0.1` embedded; `0.0.0.0` standalone | Override worker bind host |
| `PORT` | Standalone worker / container | `8081` in worker; `3003` in app image | Usually injected by the hosting platform |
| `COMPUTE_JOB_CONCURRENCY` | Compute | `1` | Shared compute concurrency cap |
| `COMPUTE_WHISPER_TIMEOUT_MS` | Compute | `30000` | Whisper alignment timeout budget |
| `COMPUTE_PDF_TIMEOUT_MS` | Compute | `300000` | PDF parse timeout budget |
| `COMPUTE_TTS_PLAYBACK_SEGMENT_TIMEOUT_MS` | Compute | Whisper timeout | Per-segment TTS generation timeout budget |
| `COMPUTE_PDF_JOB_ATTEMPTS` | Compute | `1` | Max JetStream deliveries for PDF layout jobs |
| `COMPUTE_PREWARM_MODELS` | Compute | `false` | Set `true` to pre-download worker models at startup |
| `COMPUTE_JOBS_STREAM_MAX_BYTES` | Compute / JetStream | `268435456` | Override jobs stream retention bytes with a positive integer |
| `COMPUTE_EVENTS_STREAM_MAX_BYTES` | Compute / JetStream | `134217728` | Override events stream retention bytes with a positive integer |
| `COMPUTE_JOB_STATES_MAX_BYTES` | Compute / JetStream | `67108864` | Override job-state KV storage bytes with a positive integer |
| `COMPUTE_NATS_REPLICAS` | Compute / JetStream | `1`; only `1`, `3`, or `5` survive normalization | Use `3` or `5` for a clustered NATS deployment |
| `COMPUTE_OP_STALE_MS` | Compute | `max(30m, 4x max compute timeout)` | Shared stale window for compute op replacement |
| `WHISPER_MODEL_BASE_URL` | Compute model source | onnx-community default | Override Whisper ONNX model base URL |
| `PDF_LAYOUT_MODEL_BASE_URL` | Compute model source | PP-DocLayoutV3 default | Override PDF layout ONNX model base URL |
| `COMPUTE_WORKER_URL` | External compute mode | unset | Set only for standalone external worker mode |
| `COMPUTE_WORKER_PUBLIC_URL` | TTS playback | `COMPUTE_WORKER_URL` | Set when browsers need a different worker URL for audio |
| `COMPUTE_WORKER_TOKEN` | External compute mode | unset | Required for standalone external worker auth |
| `TTS_PLAYBACK_TOKEN_SECRET` | TTS playback | unset | Required for signed worker-owned playback audio URLs |
| `FFMPEG_BIN` | Audio runtime | auto-detected (`ffmpeg-static`) | Override ffmpeg binary path |
| `DISABLE_AUTH_RATE_LIMIT` | Auth request throttling | `false` | Set `true` to disable Better Auth request rate limiting |
| `ENABLE_TEST_NAMESPACE` | Testing/CI | unset | Honor `x-openreader-test-namespace` header in production builds |
| `RUN_DRIZZLE_MIGRATIONS` | DB migrations | `true` | Set `false` to skip startup Drizzle migrations |
| `RUN_V4_DECOMMISSION` | Storage decommission | `true` | Set `false` to skip startup v4 legacy object-prefix purge |
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
- Required on standalone workers and must match the app value so encrypted shared-provider credentials can be decrypted
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

### RICHARDRDEV_PRODUCTION

Official-host deployment flag for `openreader.richardr.dev`.

- Default: `false`
- Exact `true` enables the official-instance badge, official privacy notice, and US-only request gate
- Self-hosted deployments should leave it unset

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

### WEED_MINI_BIND_HOST

Bind interface for embedded SeaweedFS.

- Default: `127.0.0.1`

### WEED_MINI_ADVERTISE_HOST

Host embedded SeaweedFS advertises in generated S3 URLs.

- Default: the bind host, or a detected reachable private address when binding all interfaces

### WEED_MINI_PORT

S3-compatible port for embedded SeaweedFS.

- Default: `8333`

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

### S3_INTERNAL_ENDPOINT

Private endpoint used by the app and compute worker for S3-compatible storage.

### S3_PUBLIC_ENDPOINT

Browser-reachable HTTPS endpoint used only to generate direct presigned URLs.

### S3_BROWSER_TRANSPORT

`auto` (default), `proxy`, or `presigned`. Proxy is not allowed on Vercel/cloud request-duration hosting.

### S3_ENDPOINT

Deprecated compatibility alias for `S3_INTERNAL_ENDPOINT`; when `presigned` is explicitly selected it also supplies `S3_PUBLIC_ENDPOINT`. It will be removed in OpenReader 5.0.

### S3_FORCE_PATH_STYLE

Force path-style S3 URLs.

- Embedded default: `true`

### S3_PREFIX

Object key prefix.

- Default: `openreader`

## Library Import

### IMPORT_LIBRARY_DIRS

One or more library roots.

- Supports comma, colon, or semicolon-separated values
- Defaults to `docstore/library` when unset

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

### NATS_CREDS

Raw NATS credentials content for a standalone worker. Prefer this form on platforms that inject multiline secrets.

### NATS_CREDS_FILE

Path to a NATS credentials file for a standalone worker. `NATS_CREDS` takes precedence when both are set.

### COMPUTE_LOG_LEVEL

Compute worker log level.

- Default: `info`

### COMPUTE_WORKER_HOST

Compute worker HTTP bind host.

- Embedded default: `127.0.0.1`
- Standalone default: `0.0.0.0`

### PORT

Compute worker HTTP port.

- Worker default: `8081`
- Hosting platforms commonly inject this value
- The published app container separately sets `PORT=3003` for the Next standalone server

### COMPUTE_JOB_CONCURRENCY

Max concurrent compute jobs per worker.

- Default: `1`

### COMPUTE_WHISPER_TIMEOUT_MS

Whisper alignment timeout budget.

- Default: `30000`

### COMPUTE_PDF_TIMEOUT_MS

PDF parse timeout budget.

- Default: `300000`

### COMPUTE_TTS_PLAYBACK_SEGMENT_TIMEOUT_MS

Per-segment TTS generation timeout budget.

- Default: the resolved `COMPUTE_WHISPER_TIMEOUT_MS` value

### COMPUTE_PDF_JOB_ATTEMPTS

Max JetStream deliveries for PDF layout jobs.

- Default: `1`
- In embedded worker mode, set this in the root `.env`

### COMPUTE_PREWARM_MODELS

Controls whether the worker downloads model artifacts during startup.

- Default: `false`

### COMPUTE_JOBS_STREAM_MAX_BYTES

Maximum retained bytes in the JetStream jobs stream.

- Default: `268435456`

### COMPUTE_EVENTS_STREAM_MAX_BYTES

Maximum retained bytes in the JetStream operation-events stream.

- Default: `134217728`

### COMPUTE_JOB_STATES_MAX_BYTES

Maximum bytes used by the job-state key-value bucket.

- Default: `67108864`

### COMPUTE_NATS_REPLICAS

JetStream replica count requested by the worker.

- Default: `1`
- Accepted effective values: `1`, `3`, or `5`; other values normalize to `1`

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
- Used by the app server for internal worker API calls.
- In embedded mode, bootstrap sets this to the local embedded worker URL for the app process.

### COMPUTE_WORKER_PUBLIC_URL

Browser-reachable compute worker URL for worker-owned TTS playback audio.

- Default: `COMPUTE_WORKER_URL`
- Set this when `COMPUTE_WORKER_URL` points at an internal hostname that browsers cannot reach.
- The browser loads signed progressive MP3 playback directly from `${COMPUTE_WORKER_PUBLIC_URL}/v1/tts-playback/sessions/:sessionId/audio`.
- Do not include `COMPUTE_WORKER_TOKEN` in this URL. Browser playback uses `TTS_PLAYBACK_TOKEN_SECRET`-signed short-lived URLs instead.

### COMPUTE_WORKER_TOKEN

Shared token for app-to-external-worker requests.

- Required when `COMPUTE_WORKER_URL` points at a standalone worker.
- Never expose this token to browsers.

### TTS_PLAYBACK_TOKEN_SECRET

Secret used to sign short-lived browser-facing TTS playback URLs.

- Required for worker-owned TTS playback.
- Must be set to the same value on the app server and standalone compute worker.
- Generate with `openssl rand -base64 32`.
- This is separate from `COMPUTE_WORKER_TOKEN`; it signs public audio URLs and must not be used as the internal worker bearer token.

## Audio Runtime

### FFMPEG_BIN

Override ffmpeg binary path used for audio processing.

- Used by TTS audio normalization/probing and compute worker Whisper audio decode.

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

### RUN_V4_DECOMMISSION

Controls startup v4 legacy object-prefix purge.

- Default: `true`
- Set `false` to skip deleting retired `tts_segments_v1/`, `tts_segments_v2/`, and `audiobooks_v1/` object prefixes

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
    "ttsPlaybackBackgroundExtent": "section",
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

## Platform-Supplied Signals

These values are read by OpenReader but owned by Node.js, Next.js, the hosting platform, or the test runner. They are not deployment configuration knobs and should normally be left to the owning platform.

| Variable | Owner | OpenReader use |
| --- | --- | --- |
| `NODE_ENV` | Node.js / Next.js | Production cookie security and test-namespace defaults |
| `NEXT_RUNTIME` | Next.js | Loads Node-only instrumentation in the Node runtime |
| `VERCEL` | Vercel | Selects scheduled-task behavior, request IP handling, and rejects proxy browser storage on request-duration hosting |
| `CI` | CI runner | Test retries, server reuse, and reporter selection |
| `PWD` | Process launcher | Worker fallback for locating the bundled `docstore` directory |

## Documentation Build Variables

These variables belong only to `scripts/build-changelog-feed.mjs` and the documentation deployment workflow; they are not read by the OpenReader app or worker.

| Variable | Default / owner | Purpose |
| --- | --- | --- |
| `CHANGELOG_REPO` | `GITHUB_REPOSITORY`, then `richardr1126/openreader` | Release repository queried for changelog data |
| `CHANGELOG_PUBLIC_BASE_URL` | `https://docs.openreader.richardr.dev` | Public base used in generated changelog URLs |
| `CHANGELOG_MUTABLE_COUNT` | `3`; positive numeric input expected | Number of recent releases refreshed during incremental builds |
| `CHANGELOG_FORCE_FULL` | unset; exact `1` enables | Forces a full changelog reconciliation |
| `GITHUB_TOKEN` | GitHub Actions secret | Authenticates release API requests |
| `GITHUB_REPOSITORY` | GitHub Actions | Default changelog repository |
| `GITHUB_EVENT_PATH` | GitHub Actions | Event payload used to identify a release change |
| `GITHUB_EVENT_NAME` | GitHub Actions | Selects incremental event handling |

## Related

- [Admin Panel](../configure/admin-panel)
- [TTS Providers](../configure/tts-providers)
- [Local Development](../deploy/local-development)
- [Vercel Deployment](../deploy/vercel-deployment)
