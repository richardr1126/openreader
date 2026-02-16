---
title: Environment Variables
toc_max_heading_level: 3
---

This is the single reference page for OpenReader WebUI environment variables.

## Quick Reference Table

| Variable | Area | Default | When to set |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_NODE_ENV` | Runtime mode | treated as `development` unless `production` | Set `production` for production client behavior |
| `NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT` | Client feature flags | `true` unless set to `false` | Set `false` to hide audiobook export UI |
| `NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT` | Client feature flags | `false` unless set to `true` | Set `true` to enable word highlight + alignment |
| `API_BASE` | TTS provider | none | Point to your OpenAI-compatible TTS base URL |
| `API_KEY` | TTS provider | `none` fallback in TTS route | Set when provider requires auth |
| `TTS_CACHE_MAX_SIZE_BYTES` | TTS caching | `268435456` (256 MB) | Tune in-memory TTS cache size |
| `TTS_CACHE_TTL_MS` | TTS caching | `1800000` (30 min) | Tune in-memory TTS cache TTL |
| `TTS_MAX_RETRIES` | TTS retry | `2` | Tune retry attempts for upstream 429/5xx |
| `TTS_RETRY_INITIAL_MS` | TTS retry | `250` | Tune initial retry delay |
| `TTS_RETRY_MAX_MS` | TTS retry | `2000` | Tune max retry delay |
| `TTS_RETRY_BACKOFF` | TTS retry | `2` | Tune exponential backoff factor |
| `TTS_ENABLE_RATE_LIMIT` | Rate limiting | `false` | Set `true` to enable TTS per-user/IP daily character limits |
| `TTS_DAILY_LIMIT_ANONYMOUS` | Rate limiting | `50000` | Override anonymous per-user daily character limit |
| `TTS_DAILY_LIMIT_AUTHENTICATED` | Rate limiting | `500000` | Override authenticated per-user daily character limit |
| `TTS_IP_DAILY_LIMIT_ANONYMOUS` | Rate limiting | `100000` | Override anonymous IP backstop daily limit |
| `TTS_IP_DAILY_LIMIT_AUTHENTICATED` | Rate limiting | `1000000` | Override authenticated IP backstop daily limit |
| `BASE_URL` | Auth | unset | Required (with `AUTH_SECRET`) to enable auth |
| `AUTH_SECRET` | Auth | unset | Required (with `BASE_URL`) to enable auth |
| `AUTH_TRUSTED_ORIGINS` | Auth | empty | Add extra allowed origins |
| `USE_ANONYMOUS_AUTH_SESSIONS` | Auth | `false` | Set `true` to enable anonymous auth sessions |
| `GITHUB_CLIENT_ID` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_SECRET` to enable GitHub sign-in |
| `GITHUB_CLIENT_SECRET` | Auth/OAuth | unset | Set with `GITHUB_CLIENT_ID` to enable GitHub sign-in |
| `DISABLE_AUTH_RATE_LIMIT` | Rate limiting | `false` | Set `true` to disable auth-layer rate limiting |
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
| `RUN_DRIZZLE_MIGRATIONS` | Database migrations | `true` | Set `false` to skip startup Drizzle schema migrations |
| `RUN_FS_MIGRATIONS` | Storage migrations | `true` | Set `false` to skip startup filesystem -> S3/DB migration pass |
| `IMPORT_LIBRARY_DIR` | Library import | `docstore/library` fallback | Set a single server library root |
| `IMPORT_LIBRARY_DIRS` | Library import | unset | Set multiple roots (comma/colon/semicolon separated) |
| `WHISPER_CPP_BIN` | Word timing | unset | Set to enable `whisper.cpp` timestamps |
| `FFMPEG_BIN` | Audio runtime | auto-detected (`ffmpeg-static`) | Override ffmpeg binary path |

## Client Runtime and Feature Flags

### NEXT_PUBLIC_NODE_ENV

Controls development vs production behavior in client/server code paths.

- Typical values: `development`, `production`
- OpenReader `isDev` checks rely on this variable directly
- If this is not `production`, OpenReader treats the client as development mode
- In deployed environments, set `NEXT_PUBLIC_NODE_ENV=production` explicitly for predictable production behavior
- Affects:
  - Footer visibility in the app shell
  - DOCX upload/conversion availability in upload UI
  - Default provider/model behavior for first-run TTS config
  - DeepInfra model picker restrictions when no API key is set
  - Privacy modal wording (hosted-service vs local/dev wording)
  - Dev-only destructive document actions in settings

### NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT

Controls whether audiobook export UI/actions are shown in the client.

- Default behavior: enabled unless explicitly set to `false`
- Applies in both development and production
- Affects export entry points in PDF/EPUB pages and document settings UI

### NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT

Controls word-by-word highlighting UI and timestamp-alignment behavior.

- Default behavior: disabled unless set to `true`
- Applies in both development and production
- Requires working timestamp generation (for example `WHISPER_CPP_BIN`)
- Affects:
  - Word-highlight toggles in document settings
  - Alignment requests during TTS playback

## TTS Provider and Request Behavior

### API_BASE

Base URL for OpenAI-compatible TTS API requests.

- Example: `http://host.docker.internal:8880/v1`
- Can be overridden per request from UI settings
- Related docs: [TTS Providers](../configure/tts-providers)

### API_KEY

Default API key for TTS provider requests.

- Example: `none` or your provider token
- Can be overridden by request headers from app settings
- Related docs: [TTS Providers](../configure/tts-providers)

### TTS_CACHE_MAX_SIZE_BYTES

Maximum in-memory TTS audio cache size in bytes.

- Default: `268435456` (256 MB)

### TTS_CACHE_TTL_MS

In-memory TTS audio cache TTL in milliseconds.

- Default: `1800000` (30 minutes)

### TTS_MAX_RETRIES

Maximum retries for upstream TTS failures (429/5xx).

- Default: `2`

### TTS_RETRY_INITIAL_MS

Initial retry delay in milliseconds for TTS upstream requests.

- Default: `250`

### TTS_RETRY_MAX_MS

Maximum retry delay in milliseconds.

- Default: `2000`

### TTS_RETRY_BACKOFF

Exponential backoff multiplier between retries.

- Default: `2`

### TTS_ENABLE_RATE_LIMIT

Controls TTS character rate limiting in the TTS API.

- Default: `false` (TTS char limits disabled)
- Set to `true` to enforce `TTS_DAILY_LIMIT_*` and `TTS_IP_DAILY_LIMIT_*`
- For behavior details and examples, see [TTS Rate Limiting](../configure/tts-rate-limiting)

### TTS_DAILY_LIMIT_ANONYMOUS

Anonymous per-user daily character limit.

- Default: `50000`

### TTS_DAILY_LIMIT_AUTHENTICATED

Authenticated per-user daily character limit.

- Default: `500000`

### TTS_IP_DAILY_LIMIT_ANONYMOUS

Anonymous IP backstop daily character limit.

- Default: `100000`

### TTS_IP_DAILY_LIMIT_AUTHENTICATED

Authenticated IP backstop daily character limit.

- Default: `1000000`

## Auth and Identity

### BASE_URL

External base URL for this OpenReader instance.

- Required with `AUTH_SECRET` to enable auth
- Example: `http://localhost:3003` or `https://reader.example.com`
- Related docs: [Auth](../configure/auth)

### AUTH_SECRET

Secret key used by auth/session handling.

- Required with `BASE_URL` to enable auth
- Generate with `openssl rand -base64 32`
- Related docs: [Auth](../configure/auth)

### AUTH_TRUSTED_ORIGINS

Additional allowed origins for auth requests.

- Comma-separated list
- `BASE_URL` origin is always trusted automatically
- Related docs: [Auth](../configure/auth)

### USE_ANONYMOUS_AUTH_SESSIONS

Controls whether auth-enabled deployments can create/use anonymous sessions.

- Default: `false` (anonymous sessions disabled)
- Set `true` to allow anonymous sessions and guest-style flows
- When `false`, users must sign in or sign up with an account
- Related docs: [Auth](../configure/auth)

### GITHUB_CLIENT_ID

GitHub OAuth client ID.

- Enable only with `GITHUB_CLIENT_SECRET`

### GITHUB_CLIENT_SECRET

GitHub OAuth client secret.

- Enable only with `GITHUB_CLIENT_ID`

### DISABLE_AUTH_RATE_LIMIT

Controls Better Auth rate limiting.

- Default behavior: auth-layer rate limiting enabled
- Set to `true` to disable auth-layer rate limiting
- This does not affect TTS character rate limiting
- Related docs: [Auth](../configure/auth)

## Database and Object Blob Storage

### POSTGRES_URL

Switches metadata/auth storage from SQLite to Postgres.

- Unset: SQLite at `docstore/sqlite3.db`
- Set: Postgres mode
- Related docs: [Database](../configure/database)

### USE_EMBEDDED_WEED_MINI

Controls embedded SeaweedFS startup.

- Default behavior: treated as enabled when unset
- Set `false` to rely on external S3-compatible storage
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### WEED_MINI_DIR

Data directory for embedded SeaweedFS (`weed mini`).

- Default: `docstore/seaweedfs`
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### WEED_MINI_WAIT_SEC

Maximum seconds to wait for embedded SeaweedFS startup.

- Default: `20`
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_ACCESS_KEY_ID

Access key for S3-compatible storage.

- Auto-generated in embedded mode if unset
- Set explicitly for stable credentials or external providers
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_SECRET_ACCESS_KEY

Secret key for S3-compatible storage.

- Auto-generated in embedded mode if unset
- Set explicitly for stable credentials or external providers
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_BUCKET

Bucket name used for document blobs.

- Default in embedded mode: `openreader-documents`
- Required for external S3-compatible storage
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_REGION

Region used by the S3 client.

- Default in embedded mode: `us-east-1`
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_ENDPOINT

Endpoint URL for S3-compatible storage.

- In embedded mode, defaults to `http://<BASE_URL host>:8333` (or detected host)
- For AWS S3, usually leave unset
- For MinIO/SeaweedFS/R2/B2-style APIs, typically set explicitly
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_FORCE_PATH_STYLE

Path-style S3 addressing toggle.

- Default in embedded mode: `true`
- Set according to provider requirements
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

### S3_PREFIX

Prefix prepended to stored object keys.

- Default: `openreader`
- Related docs: [Object / Blob Storage](../configure/object-blob-storage)

## Migration Controls

### RUN_DRIZZLE_MIGRATIONS

Controls startup migration execution in shared entrypoint.

- Default: `true`
- Set `false` to skip automatic startup Drizzle schema migrations
- Related docs: [Migrations](../configure/migrations), [Database](../configure/database)

### RUN_FS_MIGRATIONS

Controls startup filesystem-to-object-store migration execution in shared entrypoint.

- Default: `true`
- Runs `scripts/migrate-fs-v2.mjs` at startup after DB migrations
- Set `false` to skip automatic storage migration pass
- Related docs: [Migrations](../configure/migrations), [Database](../configure/database), [Object / Blob Storage](../configure/object-blob-storage)

## Library Import

### IMPORT_LIBRARY_DIR

Single directory root for server library import.

- Used when `IMPORT_LIBRARY_DIRS` is unset
- Default fallback root: `docstore/library`
- Related docs: [Server Library Import](../configure/server-library-import)

### IMPORT_LIBRARY_DIRS

Multiple library roots for server library import.

- Separator: comma, colon, or semicolon
- Takes precedence over `IMPORT_LIBRARY_DIR`
- Related docs: [Server Library Import](../configure/server-library-import)

## Audio Tooling and Alignment

### WHISPER_CPP_BIN

Absolute path to compiled `whisper.cpp` binary for word-level timestamps.

- Example: `/whisper.cpp/build/bin/whisper-cli`
- Required only for optional word-by-word highlighting

### FFMPEG_BIN

Absolute path or executable name for the ffmpeg binary used by audiobook/processing routes.

- Resolution order: `FFMPEG_BIN` -> `ffmpeg-static`
- Example: `/var/task/node_modules/ffmpeg-static/ffmpeg`
