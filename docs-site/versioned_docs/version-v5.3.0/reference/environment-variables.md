---
title: Environment Variables
description: Every environment variable OpenReader reads, grouped by area.
toc_max_heading_level: 2
---

Environment variables cover infrastructure: addresses, secrets, database, storage and the compute worker. Everything else, from providers to sign-up policy, is set in [Settings → Admin](../configure/admin-panel) and takes effect without a restart.

All variables are server-side; none reach the browser. Startup checks the configuration and lists every problem at once.

## Minimal configuration

A single container or `pnpm start` needs only two values:

```dotenv
BASE_URL=http://localhost:3003          # the address you open in the browser
AUTH_SECRET=<openssl rand -base64 32>   # keep it stable; it also encrypts saved keys
```

Off localhost, also set `COMPUTE_WORKER_PUBLIC_URL` to the address browsers use for port `8081`. With the embedded worker, the worker and broker tokens are generated and the playback secret is derived from `AUTH_SECRET`, so you set none of them.

Upgrading a v4 instance? Follow [Upgrade from v4](../deploy/upgrade-from-v4).

## Sign-in

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | required | The address people open, for example `https://reader.example.com`. |
| `AUTH_SECRET` | required | Signs sessions and encrypts saved keys. App only; never set it on a standalone worker. [Keep it stable](../configure/admin-panel#how-saved-keys-are-protected). |
| `AUTH_TRUSTED_ORIGINS` | empty | Other addresses allowed to sign in, comma-separated. `BASE_URL` is always trusted. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | Turn on GitHub sign-in. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISCOVERY_URL` | unset | Turn on OpenID Connect sign-in. The discovery URL must be `https://` except on localhost. |
| `OIDC_PROVIDER_ID` | `oidc` | Used in the callback path `<BASE_URL>/api/auth/callback/<id>`. |
| `OIDC_PROVIDER_NAME` | `SSO` | The sign-in button label. |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes, space- or comma-separated. |
| `BOOTSTRAP_ADMIN_EMAIL` | unset | The [first administrator](../configure/admin-panel#create-the-first-administrator) on a new database. |
| `BOOTSTRAP_ADMIN_PASSWORD` | unset | Their initial password, at least 16 characters. |
| `BOOTSTRAP_ADMIN_PASSWORD_FILE` | unset | Read the initial password from a file instead (one trailing newline is removed). |
| `CRON_SECRET` | unset | Required on Vercel; authorizes the [scheduled-task cron](../configure/maintenance#how-tasks-are-triggered). |
| `DISABLE_AUTH_RATE_LIMIT` | `false` | Turns off sign-in rate limiting. For tests only. |

Setup details are in [Users and Sign-in](../configure/auth). `ADMIN_EMAILS` from v4 is no longer used.

### `DESKTOP_LAUNCH_TOKEN`

Internal to the desktop app; never set it yourself. The desktop shell generates a new token on every launch and exchanges it once at `POST /api/auth/desktop/session` for a session for the app's single owner, who has no password. When it is unset, that route does not exist. It also switches the interface to the desktop layout. Startup refuses a value shorter than 32 characters, and the embedded worker, NATS and SeaweedFS never receive it.

### `RICHARDRDEV_PRODUCTION`

Only for the official instance at `openreader.richardr.dev`. Exactly `true` shows the official-instance label and privacy notice and limits requests to the US. Leave it unset.

## Database and Object Blob Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_URL` | unset | Use Postgres instead of SQLite. |
| `SQLITE_DB_PATH` | `docstore/sqlite3.db` | Move the SQLite file. Relative paths start from the app directory. |
| `USE_EMBEDDED_WEED_MINI` | `true` | Set `false` to use external S3-compatible storage. |
| `S3_BUCKET` | `openreader-documents` (embedded) | Required for external storage. |
| `S3_REGION` | `us-east-1` (embedded) | Required for external storage. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | generated (embedded) | Required for external storage. |
| `S3_INTERNAL_ENDPOINT` | `http://127.0.0.1:8333` (embedded) | The endpoint the app and worker use. Set it for non-AWS services. A [separate worker](../deploy/compute-worker) needs an address it can reach, which may differ from the app's. |
| `S3_PUBLIC_ENDPOINT` | unset | A public HTTPS endpoint for browsers, used with `presigned` transfers. |
| `S3_BROWSER_TRANSPORT` | `auto` | `proxy`, `presigned` or `auto`. See [how browsers reach files](../configure/object-blob-storage#how-browsers-reach-files). `proxy` is refused on Vercel. |
| `S3_FORCE_PATH_STYLE` | `true` (embedded) | Path-style URLs, as many non-AWS services require. |
| `S3_PREFIX` | `openreader` | Prefix for every object key. |
| `S3_AUTO_CREATE_BUCKET` | `false` | Create the bucket on startup if it is missing. The full Compose examples turn it on. |
| `WEED_MINI_DIR` | `docstore/seaweedfs` | Embedded SeaweedFS data directory. |
| `WEED_MINI_PORT` | `8333` | Embedded SeaweedFS S3 port. If a port is taken, startup moves SeaweedFS's internal ports. |
| `WEED_MINI_BIND_HOST` | `127.0.0.1` | Embedded SeaweedFS listening address. |
| `WEED_MINI_ADVERTISE_HOST` | the bind host | The address embedded SeaweedFS advertises. When bound to all interfaces, a private address is detected. |
| `WEED_MINI_WAIT_SEC` | `20` | How long startup waits for embedded SeaweedFS. |

## Library Import

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMPORT_LIBRARY_DIRS` | `docstore/library` | Folders for [Server Library Import](../configure/server-library-import), separated by commas, colons or semicolons. |

## Compute Worker and Model Configuration

### Connecting the app and worker

Only needed with a [standalone worker](../deploy/compute-worker).

| Variable | Set on | Purpose |
| --- | --- | --- |
| `COMPUTE_WORKER_URL` | app | The worker's address. Leave unset to run the embedded worker. |
| `COMPUTE_WORKER_PUBLIC_URL` | app | The worker address browsers load audio from. Defaults to `COMPUTE_WORKER_URL`. Also needed with the embedded worker when the app is not on localhost. |
| `COMPUTE_WORKER_TOKEN` | both | Authorizes the app's requests to the worker. |
| `COMPUTE_CREDENTIAL_BROKER_TOKEN` | both | Authorizes the worker's requests to the app for provider keys. |
| `COMPUTE_CREDENTIAL_BROKER_URL` | worker | `https://<app>/api/internal/compute/tts-credentials`. Never the worker's public address. |
| `COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS` | worker | Default `5000`. |
| `TTS_PLAYBACK_TOKEN_SECRET` | both | Signs short-lived audio links and keys the audio cache. See below. |
| `NATS_URL` | worker | The NATS server. The embedded worker uses `nats://127.0.0.1:4222`. |
| `NATS_CREDS` or `NATS_CREDS_FILE` | worker | NATS credentials, inline or as a file path. `NATS_CREDS` wins when both are set. |

Generate each token with `openssl rand -base64 32` and use the same value on both sides.

`TTS_PLAYBACK_TOKEN_SECRET` is optional with the embedded worker: it is derived from `AUTH_SECRET`, and a value you set always wins. A standalone worker never receives `AUTH_SECRET`, so it needs the explicit value. Changing it, or `AUTH_SECRET` when derived, makes cached audio regenerate. The example Compose files ship a local default; replace it before exposing a stack beyond your machine.

### Worker tuning

These have sensible defaults. With the embedded worker, set them in the app's `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8081` | Standalone worker port. Platforms usually set it. (The app image uses `3003` for itself.) |
| `COMPUTE_WORKER_HOST` | `127.0.0.1` embedded, `0.0.0.0` standalone | Listening address. The Docker image sets `0.0.0.0` so port `8081` can be published. |
| `COMPUTE_LOG_LEVEL` | `info` | Worker log level. |
| `COMPUTE_WHISPER_TIMEOUT_MS` | `30000` | Word-timing alignment timeout. |
| `COMPUTE_TTS_PLAYBACK_SEGMENT_TIMEOUT_MS` | the Whisper timeout | Timeout for generating one segment. |
| `COMPUTE_PDF_TIMEOUT_MS` | `300000` | PDF layout analysis timeout. |
| `COMPUTE_PDF_JOB_ATTEMPTS` | `1` | Attempts per PDF layout job. |
| `COMPUTE_OP_STALE_MS` | 30 minutes, or 4× the longest timeout | When an unfinished operation may be replaced. |
| `COMPUTE_PREWARM_MODELS` | `false` | Download models at startup instead of on first use. |
| `WHISPER_MODEL_BASE_URL` | Hugging Face | Mirror for Whisper model files. |
| `PDF_LAYOUT_MODEL_BASE_URL` | Hugging Face | Mirror for PDF layout model files. |
| `COMPUTE_JOBS_STREAM_MAX_BYTES` | `268435456` | JetStream jobs stream size. |
| `COMPUTE_EVENTS_STREAM_MAX_BYTES` | `134217728` | JetStream events stream size. |
| `COMPUTE_JOB_STATES_MAX_BYTES` | `67108864` | JetStream job-state store size. |
| `COMPUTE_NATS_REPLICAS` | `1` | JetStream replicas: `1`, `3` or `5` for a NATS cluster. Other values become `1`. |
| `FFMPEG_BIN` | see below | The ffmpeg used for audio conversion, timing and audiobook export. |

`FFMPEG_BIN` is set to a pinned LGPL build in the published images and the desktop app, and to the `ffmpeg-static` dependency by `pnpm dev`/`pnpm start`. Otherwise `ffmpeg` is taken from `PATH`.

### Embedded services

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDED_COMPUTE_WORKER_PORT` | `8081` | Embedded worker port. |
| `EMBEDDED_NATS_PORT` | `4222` | Embedded NATS client port. |
| `EMBEDDED_NATS_MONITOR_PORT` | `8222` | Embedded NATS monitoring port. |
| `EMBEDDED_NATS_STORE_DIR` | `docstore/nats/jetstream` | Embedded JetStream data directory. |

## Logging

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_FORMAT` | `pretty` | `json` for structured logs, on the app and worker. |
| `LOG_LEVEL` | `info` | App log level. The worker uses `COMPUTE_LOG_LEVEL`. |

## Migration Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUN_DRIZZLE_MIGRATIONS` | `true` | Set `false` to skip database migrations on startup. |
| `RUN_V4_DECOMMISSION` | `true` | Set `false` to skip deleting retired v4 storage on startup. |

See [Database and Migrations](../configure/database#migrations).

## TTS Provider and Request Behavior

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE` | unset | On first start, creates a `default-openai` provider with this base URL. |
| `API_KEY` | unset | That provider's API key. `API_BASE` alone is enough for servers without keys. |
| `API_MODEL_NAME` | `kokoro` | That provider's default model. Does not create a provider by itself. |

These are read only while no providers exist and the seed below has no `providers` key. See [Seed a provider from the environment](../configure/tts-providers#seed-a-provider-from-the-environment).

## Runtime JSON Seed

`RUNTIME_SEED_JSON` (inline) or `RUNTIME_SEED_JSON_PATH` (a file; wins when both are set) fills in admin settings on first start. Seeds only add values that are missing. They never overwrite a value an admin has set, and changing the seed later does nothing. See [Settings from seeds](../configure/admin-panel#settings-from-seeds-and-from-the-admin-panel).

```json
{
  "version": 1,
  "runtimeConfig": {
    "signupPolicy": "open",
    "allowAnonymousSessions": false,
    "defaultTtsProvider": "default-openai",
    "enableTtsProvidersTab": true,
    "enableAudiobookExport": true,
    "enableDocxConversion": true,
    "showAllProviderModels": true,
    "ttsCacheMaxSizeBytes": 268435456,
    "ttsCacheTtlMs": 1800000,
    "ttsUpstreamMaxRetries": 2,
    "ttsUpstreamTimeoutMs": 285000,
    "ttsPlaybackBackgroundExtent": "section",
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
  ],
  "accountEmail": {
    "enabled": true,
    "senderName": "OpenReader",
    "senderEmail": "mail@example.com",
    "replyTo": "support@example.com",
    "apiKey": "REPLACE_WITH_RESEND_API_KEY"
  },
  "gutendex": {
    "enabled": true,
    "serverUrl": "https://gutendex.example.com",
    "apiKey": "REPLACE_WITH_GUTENDEX_API_KEY"
  }
}
```

| Key | Notes |
| --- | --- |
| `version` | Required; must be `1`. |
| `runtimeConfig` | Any [instance](../configure/instance-settings) or [compute](../configure/compute-rate-limiting) setting, by key. Unknown keys stop startup. `computeLimitPolicies` must be a complete policy; start from [`examples/openreader-seed.json`](https://github.com/richardr1126/openreader/blob/main/examples/openreader-seed.json). |
| `providers` | Shared providers. When present, even as `[]`, the `API_*` variables are ignored. |
| `accountEmail` | Resend settings. `enabled`, `senderName`, `senderEmail` and `apiKey` are required; `replyTo` may be `null`. |
| `gutendex` | A Project Gutenberg catalog server. Omit it to use the public `gutendex.com`. When present, `serverUrl` is required, `enabled` defaults to `true`, and `apiKey` may be `null`. |

API keys in a seed are encrypted with `AUTH_SECRET` when stored. Keep the seed secret and out of version control.

## Platform-Supplied Signals

Set by Node.js, Next.js, the host or the test runner; not configuration.

| Variable | Set by | Effect |
| --- | --- | --- |
| `NODE_ENV` | Node.js / Next.js | Secure cookies and production behavior. |
| `NEXT_RUNTIME` | Next.js | Loads server-only startup code. |
| `VERCEL` | Vercel | Cron-driven scheduled tasks, request IP handling, and refusing `proxy` storage transfers. |
| `CI` | CI runners | Test retries and reporters. |
| `PWD` | The shell | Where the worker looks for `docstore` when run from source. |

## Documentation Build Variables

Read only by `scripts/build-changelog-feed.mjs` and the docs deployment workflow.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHANGELOG_REPO` | `GITHUB_REPOSITORY`, then `richardr1126/openreader` | Repository whose releases are read. |
| `CHANGELOG_PUBLIC_BASE_URL` | `https://docs.openreader.richardr.dev` | Base of generated changelog links. |
| `CHANGELOG_MUTABLE_COUNT` | `3` | Recent releases refreshed on each build. |
| `CHANGELOG_FORCE_FULL` | unset | Exactly `1` rebuilds the whole changelog. |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME` | GitHub Actions | Release API access and event handling. |
