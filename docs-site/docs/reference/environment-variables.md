---
title: Environment Variables
toc_max_heading_level: 3
---

This is the single reference page for OpenReader environment variables.

:::note Recommended configuration path
For auth-enabled deployments, use **Settings → Admin** as the primary source of truth for shared TTS providers and site features. Legacy env vars (`API_KEY`, `API_BASE`, and `NEXT_PUBLIC_*`) are optional first-boot seeds only.
:::

## Quick Reference Table

| Variable | Area | Default | When to set |
| --- | --- | --- | --- |
| `ADMIN_EMAILS` | Auth/Admin | empty | Comma-separated emails auto-promoted to admin (requires auth enabled) |
| `API_BASE` | Legacy bootstrap seed | none | Optional first-boot seed into `default-openai`; then manage in Settings → Admin → Shared providers |
| `API_KEY` | Legacy bootstrap seed | none | Optional first-boot seed into `default-openai`; then manage in Settings → Admin → Shared providers |
| `NEXT_PUBLIC_*` runtime seeds | Legacy bootstrap seed | varies | Optional first-boot seeds for site features; then manage in Settings → Admin → Site features |
| `NEXT_PUBLIC_CHANGELOG_FEED_URL` | Legacy bootstrap seed | `https://docs.openreader.richardr.dev/changelog/manifest.json` | Optional first-boot seed for changelog feed URL; then manage in Settings → Admin → Site features |
| `NEXT_PUBLIC_ENABLE_USER_SIGNUPS` | Legacy bootstrap seed | `true` | Optional first-boot seed for whether new accounts can be created; then manage in Settings → Admin → Site features |
| `TTS_CACHE_MAX_SIZE_BYTES` | TTS caching | `268435456` (256 MB) | Tune in-memory TTS cache size |
| `TTS_CACHE_TTL_MS` | TTS caching | `1800000` (30 min) | Tune in-memory TTS cache TTL |
| `TTS_MAX_RETRIES` | TTS retry | `2` | Tune retry attempts for upstream 429/5xx |
| `TTS_RETRY_INITIAL_MS` | TTS retry | `250` | Tune initial retry delay |
| `TTS_RETRY_MAX_MS` | TTS retry | `2000` | Tune max retry delay |
| `TTS_RETRY_BACKOFF` | TTS retry | `2` | Tune exponential backoff factor |
| `TTS_UPSTREAM_TIMEOUT_MS` | TTS request timeout | `285000` | Set max upstream TTS request duration before fail-fast |
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
| `OPENREADER_COMPUTE_MODE` | Heavy compute backend | `local` | Set to `none` to disable ONNX word alignment + PDF layout parsing |
| `OPENREADER_COMPUTE_WORKER_URL` | Heavy compute backend | unset | Reserved for future worker backend mode (`worker`) |
| `OPENREADER_COMPUTE_WORKER_TOKEN` | Heavy compute backend | unset | Reserved for future worker backend mode (`worker`) |
| `OPENREADER_PDF_LAYOUT_MODEL_URL` | PDF layout model | PP-DocLayoutV3 ONNX URL | Override ONNX model URL for `ensureModel()` |
| `OPENREADER_PDF_LAYOUT_MODEL_DATA_URL` | PDF layout model | PP-DocLayoutV3 ONNX data URL | Override ONNX external data URL for `ensureModel()` |
| `OPENREADER_PDF_LAYOUT_CONFIG_URL` | PDF layout model | PP-DocLayoutV3 config URL | Override model config URL for `ensureModel()` |
| `OPENREADER_PDF_LAYOUT_PREPROCESSOR_URL` | PDF layout model | PP-DocLayoutV3 preprocessor URL | Override model preprocessor URL for `ensureModel()` |
| `OPENREADER_WHISPER_MODEL_*_URL` | Whisper ONNX model | onnx-community defaults | Optional per-artifact URL overrides for ONNX whisper-base_timestamped int8 downloads |
| `FFMPEG_BIN` | Audio runtime | auto-detected (`ffmpeg-static`) | Override ffmpeg binary path |



## TTS Provider and Request Behavior

### API_BASE

Bootstrap base URL for the legacy OpenAI-compatible TTS endpoint.

- Example: `http://host.docker.internal:8880/v1`
- **Seeded on first boot** into the auto-created `default-openai` shared provider, then no longer read by the running app. Manage in **Settings → Admin → Shared providers** afterwards.
- Related docs: [Admin Panel](../configure/admin-panel), [TTS Providers](../configure/tts-providers)

### API_KEY

Bootstrap API key for the legacy OpenAI-compatible TTS endpoint.

- Example: your provider token, or omit if the provider doesn't require auth
- **Seeded on first boot** into the auto-created `default-openai` shared provider (encrypted at rest), then no longer read by the running app. Manage in **Settings → Admin → Shared providers** afterwards.
- Related docs: [Admin Panel](../configure/admin-panel), [TTS Providers](../configure/tts-providers)

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

### TTS_UPSTREAM_TIMEOUT_MS

Maximum upstream TTS request timeout in milliseconds.

- Default: `285000` (285 seconds)
- Applies to outbound provider calls from server routes using shared TTS generation
- Increase for slower providers/models; decrease to fail fast and surface retryable errors sooner

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
- Generate with `openssl rand -hex 32`
- Also used to HMAC-hash server-side TTS segment text fingerprints
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

### ADMIN_EMAILS

Comma-separated list of email addresses that are auto-promoted to admin.

- Default: empty (no admins)
- Requires auth to be enabled (`AUTH_SECRET` + `BASE_URL`).
- Matched emails get `user.is_admin = true` on every session resolution; removed emails are demoted on the next session resolve.
- Admins see a new **Admin** tab in Settings exposing shared TTS providers and site-wide feature toggles. Keys for shared providers are stored encrypted in the DB and never returned to the client.
- Example: `ADMIN_EMAILS=alice@example.com,bob@example.com`
- Related docs: [Admin Panel](../configure/admin-panel), [Auth](../configure/auth)

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

### OPENREADER_COMPUTE_MODE

Selects the backend for heavy compute features (ONNX word alignment + PDF layout parsing).

- Default: `local`
- Supported in v1:
  - `local`: run compute in-process on the app server
  - `none`: disable these features cleanly
- `worker` is reserved for a future external worker backend and currently fails fast at startup if selected

### OPENREADER_COMPUTE_WORKER_URL

Reserved for future external compute worker mode.

- Used only when `OPENREADER_COMPUTE_MODE=worker` (not implemented in v1)
- Leave unset in v1

### OPENREADER_COMPUTE_WORKER_TOKEN

Reserved bearer token for future external compute worker mode.

- Used only when `OPENREADER_COMPUTE_MODE=worker` (not implemented in v1)
- Leave unset in v1

### OPENREADER_PDF_LAYOUT_MODEL_URL

Override URL for the PP-DocLayoutV3 ONNX model downloaded by `ensureModel()`.

- Default: `https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/PP-DocLayoutV3.onnx`
- Optional for custom mirrors/air-gapped workflows

### OPENREADER_PDF_LAYOUT_MODEL_DATA_URL

Override URL for the PP-DocLayoutV3 ONNX external data file downloaded by `ensureModel()`.

- Default: `https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/PP-DocLayoutV3.onnx.data`

### OPENREADER_PDF_LAYOUT_CONFIG_URL

Override URL for the PP-DocLayoutV3 `config.json` downloaded by `ensureModel()`.

- Default: `https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/config.json`

### OPENREADER_PDF_LAYOUT_PREPROCESSOR_URL

Override URL for the PP-DocLayoutV3 `preprocessor_config.json` downloaded by `ensureModel()`.

- Default: `https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/preprocessor_config.json`
- You can pre-populate the model cache via `pnpm fetch-models`

### OPENREADER_WHISPER_MODEL_*_URL

Optional per-artifact override URLs for the built-in ONNX Whisper alignment model downloader.

- Default base: `https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main`
- Default model variant: int8 (`encoder_model_int8.onnx`, `decoder_model_merged_int8.onnx`, `decoder_with_past_model_int8.onnx`)
- Use these when you need mirrors, pinned snapshots, or air-gapped fetch routing.

Supported override vars:

- `OPENREADER_WHISPER_MODEL_CONFIG_URL`
- `OPENREADER_WHISPER_MODEL_GENERATION_CONFIG_URL`
- `OPENREADER_WHISPER_MODEL_TOKENIZER_URL`
- `OPENREADER_WHISPER_MODEL_TOKENIZER_CONFIG_URL`
- `OPENREADER_WHISPER_MODEL_MERGES_URL`
- `OPENREADER_WHISPER_MODEL_VOCAB_URL`
- `OPENREADER_WHISPER_MODEL_NORMALIZER_URL`
- `OPENREADER_WHISPER_MODEL_ADDED_TOKENS_URL`
- `OPENREADER_WHISPER_MODEL_PREPROCESSOR_URL`
- `OPENREADER_WHISPER_MODEL_SPECIAL_TOKENS_MAP_URL`
- `OPENREADER_WHISPER_MODEL_ENCODER_URL`
- `OPENREADER_WHISPER_MODEL_DECODER_MERGED_URL`
- `OPENREADER_WHISPER_MODEL_DECODER_WITH_PAST_URL`

### FFMPEG_BIN

Absolute path or executable name for the ffmpeg binary used by audiobook/processing routes.

- Resolution order: `FFMPEG_BIN` -> `ffmpeg-static`
- Example: `/var/task/node_modules/ffmpeg-static/ffmpeg`

## Legacy First-Boot Runtime Seeds (optional)

These variables exist only as **first-boot seeds** for the admin-managed runtime config. Prefer changing site features from **Settings → Admin → Site features**. Keep these only when you need bootstrap defaults before the first admin login. See [Admin Panel](../configure/admin-panel) for migration behavior.

The values are SSR-injected via `window.__OPENREADER_RUNTIME_CONFIG__`, so admin edits take effect for all users on the next page load — no rebuild required (unlike the old `NEXT_PUBLIC_*` build-time pattern).

### NEXT_PUBLIC_ENABLE_DOCX_CONVERSION

Controls whether the experimental DOCX-to-PDF conversion and upload feature is enabled.

- Default: `true` (enabled)
- Runtime key: `enableDocxConversion`

### NEXT_PUBLIC_ENABLE_DESTRUCTIVE_DELETE_ACTIONS

Controls whether the "Delete all user docs" and other bulk-delete buttons are shown in Settings.

- Default: `true` (enabled)
- Runtime key: `enableDestructiveDeleteActions`

### NEXT_PUBLIC_ENABLE_TTS_PROVIDERS_TAB

Controls whether the **TTS Provider** section appears in the user-facing Settings modal.

- Default: `true` (enabled)
- Set `false` to hide provider/model/API controls in the per-user Settings modal (the admin panel is unaffected).
- Runtime key: `enableTtsProvidersTab`

### NEXT_PUBLIC_ENABLE_USER_SIGNUPS

Controls whether new user accounts can be created.

- Default: `true` (enabled)
- When `false`, new account creation is blocked for email sign-up, first-time OAuth signup, and anonymous-to-account upgrades.
- Existing users can still sign in.
- Runtime key: `enableUserSignups`

### NEXT_PUBLIC_RESTRICT_USER_API_KEYS

Controls whether users can supply personal API keys/base URLs for built-in providers.

- Default: runtime-dependent
- When `true`, server routes only use admin-managed shared providers.
- When `false`, users can use per-user BYOK credentials for built-in providers.
- Runtime key: `restrictUserApiKeys`

### NEXT_PUBLIC_DEFAULT_TTS_PROVIDER

Sets the default TTS provider for new users.

- Default: `custom-openai`
- Example values: `replicate`, `deepinfra`, `openai`, `custom-openai`, or an admin-defined shared provider slug (e.g. `kokoro-prod`)
- Runtime key: `defaultTtsProvider`

`showAllProviderModels` is a runtime-only admin setting (no env seed). Configure it in **Settings → Admin → Site features**.

### NEXT_PUBLIC_CHANGELOG_FEED_URL

Sets the changelog manifest URL used by the Settings modal changelog viewer.

- Default: `https://docs.openreader.richardr.dev/changelog/manifest.json`
- Use this in self-hosted deployments when you publish changelog feeds to a custom docs domain/path.
- Runtime key: `changelogFeedUrl`


### NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT

Controls whether audiobook export UI/actions are shown in the client.

- Default: `true` (enabled)
- Affects export entry points in PDF/EPUB pages and document settings UI
- Runtime key: `enableAudiobookExport`
