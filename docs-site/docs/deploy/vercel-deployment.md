---
title: Vercel Deployment
---

This guide covers deploying OpenReader WebUI to Vercel with external Postgres and S3-compatible object storage.

## What works on Vercel

- Documents (PDF/EPUB/TXT/MD) work with `POSTGRES_URL` + external S3 storage.
- Audiobook routes work on Node.js serverless functions using `ffmpeg-static`.

:::warning DOCX Conversion Limitation
`docx` conversion requires `soffice` (LibreOffice), which is not available in a standard Vercel runtime.
:::

## 1. Environment Variables

Recommended production setup (auth enabled):

```bash
POSTGRES_URL=postgres://...
USE_EMBEDDED_WEED_MINI=false
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
S3_REGION=us-east-1
S3_PREFIX=openreader
BASE_URL=https://your-app.vercel.app
AUTH_SECRET=...
NEXT_PUBLIC_NODE_ENV=production
# Optional client/runtime feature overrides:
# NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT=false
# NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT=true
# Optional (non-AWS S3-compatible providers):
# S3_ENDPOINT=https://...
# S3_FORCE_PATH_STYLE=true
```

:::info `NEXT_PUBLIC_*` feature flags
- `NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT=false`: hides audiobook export UI entry points.
- `NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT=true`: enables word-highlight UI and timestamp alignment requests.
:::

:::warning `NEXT_PUBLIC_NODE_ENV` behavior
Use `NEXT_PUBLIC_NODE_ENV=production` on Vercel unless you explicitly want dev-oriented client behavior.

With `production`:
- Footer is shown in the app shell
- DOCX upload/conversion option is hidden
- Default provider/model behavior is production-oriented
- DeepInfra model picker is restricted without an API key
- Privacy modal shows hosted-service/operator wording
- Dev-only destructive document actions are hidden

With unset/non-`production`, the inverse dev behavior applies.

Full details: [Environment Variables](../reference/environment-variables#next_public_node_env).
:::

:::warning Auth recommendation
For internet-exposed Vercel deployments, set both `BASE_URL` and `AUTH_SECRET`. Running without auth is possible, but not recommended for public environments.
:::

:::tip
For all variables and defaults, see [Environment Variables](../reference/environment-variables).
:::

## 2. FFmpeg packaging in Vercel functions

`ffmpeg-static` binaries must be included in function traces. This repo already does that in `next.config.ts` via `outputFileTracingIncludes` for:

- `/api/audiobook`
- `/api/audiobook/chapter`
- `/api/audiobook/status`
- `/api/whisper`

:::info
`serverExternalPackages` should include `ffmpeg-static` so package paths resolve at runtime instead of being bundled into route output.
:::

If you change route paths or split handlers, update `outputFileTracingIncludes` accordingly.

## 3. Function memory sizing

FFmpeg workloads benefit from more memory/CPU. This repo includes:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "app/api/audiobook/route.ts": { "memory": 3009 },
    "app/api/whisper/route.ts": { "memory": 3009 }
  }
}
```

Adjust memory per route if your files are larger or your plan differs.

## 4. Runtime expectations and caveats

- Audiobook APIs require S3 configuration; otherwise they return `503`.
- For production Vercel deploys, use `POSTGRES_URL` instead of SQLite.
- Filesystem-to-object-store migrations run via server scripts/entrypoint (`scripts/migrate-fs-v2.mjs`), not API routes.
- Vercel deployments do not run `scripts/openreader-entrypoint.mjs`, so run `pnpm migrate-fs` in a controlled environment when migrating legacy filesystem data.

## 5. Smoke test after deploy

1. Upload and read a PDF/EPUB document.
2. Confirm sync/blob fetch works across refreshes/devices.
3. Generate at least one audiobook chapter and play/download it.
4. If using word highlighting, verify timestamps are produced and rendered.
