---
title: Vercel Deployment
---

This guide covers deploying OpenReader to Vercel with external Postgres and S3-compatible object storage.

## What works on Vercel

- Documents (PDF/EPUB/TXT/MD) work with `POSTGRES_URL` + external S3 storage.
- Audiobook routes work on Node.js serverless functions using `ffmpeg-static`.

:::warning DOCX Conversion Limitation
`docx` conversion requires `soffice` (LibreOffice), which is not available in a standard Vercel runtime.
:::

## 1. Environment Variables

Recommended production setup (auth enabled):

```bash
API_BASE=https://api.deepinfra.com/v1/openai
API_KEY=your_deepinfra_key
POSTGRES_URL=postgres://...
USE_EMBEDDED_WEED_MINI=false
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
S3_REGION=us-east-1
S3_PREFIX=openreader
BASE_URL=https://your-app.vercel.app
AUTH_SECRET=...
# Optional client/runtime feature defaults:
NEXT_PUBLIC_ENABLE_DOCX_CONVERSION=false
NEXT_PUBLIC_ENABLE_DESTRUCTIVE_DELETE_ACTIONS=false
NEXT_PUBLIC_DEFAULT_TTS_PROVIDER=deepinfra
NEXT_PUBLIC_DEFAULT_TTS_MODEL=hexgrad/Kokoro-82M
NEXT_PUBLIC_SHOW_ALL_DEEPINFRA_MODELS=false
NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT=true
NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT=false
# Optional (non-AWS S3-compatible providers):
# S3_ENDPOINT=https://...
# S3_FORCE_PATH_STYLE=true
```

:::info Production Configuration & Feature Flags
We recommend setting these defaults for a production-like environment:

- `NEXT_PUBLIC_ENABLE_DOCX_CONVERSION=false`: Disables DOCX upload (requires external tools anyway)
- `NEXT_PUBLIC_ENABLE_DESTRUCTIVE_DELETE_ACTIONS=false`: Hides destructive "Delete All" actions
- `NEXT_PUBLIC_DEFAULT_TTS_PROVIDER=deepinfra`: Points default TTS to a scalable provider
- `NEXT_PUBLIC_DEFAULT_TTS_MODEL=hexgrad/Kokoro-82M`: Uses a high-quality default model
- `NEXT_PUBLIC_SHOW_ALL_DEEPINFRA_MODELS=false`: Restricts usage to free models if no key is provided
- `NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT=true`: (Optional) Controls audiobook export UI
- `NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT=false`: (Optional) Controls word highlighting UI (requires timestamp backend)
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
