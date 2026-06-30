---
title: Object / Blob Storage
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

This page documents storage backends, blob upload routing, and core Docker mount behavior.

## Scope of this page

- Focus: object/blob backends, keyspaces, upload/read paths, and storage debugging.
- Not covered here: relational metadata tables and SQL state modeling (see [Database](./database)).

## Storage backends

- Embedded (default): embedded SeaweedFS (`weed mini`) blob storage.
- External: external S3-compatible object storage.

Metadata database mode (SQLite vs Postgres) is configured separately in [Database](./database).

:::warning SeaweedFS Compatibility Note (April 16, 2026)
OpenReader currently pins embedded SeaweedFS to `4.18` in CI and Docker builds.
`4.19` introduced intermittent `InternalError` responses on S3 `PutObject` in our upload flow.
:::

Storage variables are documented in [Environment Variables](../reference/environment-variables#database-and-object-blob-storage).

## Ports

- `3003`: OpenReader app and API routes
- `8333`: Embedded SeaweedFS S3 endpoint for direct browser blob access

:::info
`8333` is only needed for direct browser presigned access to embedded SeaweedFS.
:::

## Upload behavior

- Primary path: browser uploads to presigned URL from `/api/documents/blob/upload/presign`.
- Fallback path: `/api/documents/blob/upload/fallback` when direct upload fails/unreachable.
- Document read path: direct presigned access from `/api/documents/blob/get/presign`, with `/api/documents/blob/get/fallback` as the app-server fallback.
- Preview path: `/api/documents/blob/preview/ensure` reports generation status and version; presigned and fallback routes serve the generated artifact.

## Browser Cache Storage

The browser may retain reusable document, preview, and TTS audio responses in the versioned `openreader-blobs-v1` Cache Storage cache. This is strictly an evictable performance optimization:

- The server database and object storage remain authoritative.
- Clearing or losing Cache Storage must not change application correctness.
- Cache keys are same-origin synthetic identities and are not fetchable server routes.
- Successful full `200` responses may be cached; partial, opaque, redirect-error, and failed responses are not.
- Presigned URLs are network sources only and are never used as persistent cache identities.

Synthetic key layouts:

- `/openreader-cache/documents/{documentId}/{contentVersion}`
- `/openreader-cache/previews/{documentId}/{previewVersion}`
- `/openreader-cache/audio/{audioKey}/{version}`

Explicit audiobook MP3 exports are not persistently cached.

## Document previews

- PDF/EPUB previews are generated server-side and stored in object storage under `document_previews_v1`.
- Preview generation is triggered on upload registration and also backfills on first preview request for older docs.
- Preview artifacts are temporary-cache friendly and can be regenerated from the source document blob.

## FS / Volume Mounts

### App data mount

- Target: `/app/docstore`
- Recommended: yes, for persistence
- Purpose: persists SeaweedFS blob data, SQLite metadata DB, migrations, and local runtime temp state
- Mount string: `-v openreader_docstore:/app/docstore`

### Library source mount (optional)

- Target: `/app/docstore/library`
- Recommended: optional, use read-only (`:ro`)
- Purpose: exposes host files as a source for server library import
- Mount string: `-v /path/to/your/library:/app/docstore/library:ro`
- Details: [Server Library Import](./server-library-import)

## Private blob endpoint mode

If `8333` is not published externally:

- Document uploads still work through upload fallback proxy
- Reads/snippets continue through app API routes
- Direct presigned browser upload/download to embedded endpoint is unavailable

:::warning
Without `8333`, expect higher app-server traffic because uploads/downloads go through API routes instead of direct object endpoint access.
:::

## TTS Playback Storage

Worker-owned TTS playback artifacts are stored under dedicated playback keyspaces.

Typical key layout:

- `${S3_PREFIX}/tts_playback_segments_audio_v1/users/<url-encoded-user-id>/docs/<document-id>/<document-version>/<settings-hash>/<audio-content-hash>.mp3`
- `${S3_PREFIX}/tts_playback_segments_audio_v1/ns/<test-namespace>/users/<url-encoded-user-id>/docs/...` (test namespace mode)
- `${S3_PREFIX}/tts_playback_segments_v1/users/<user-hash>/docs/<document-id>/<document-version>/<settings-hash>/segments/<ordinal>.json`
- `${S3_PREFIX}/tts_playback_plan_v1/...`
- `${S3_PREFIX}/tts_playback_v1/...`

Notes:

- The legacy `tts_segments_v1/`, `tts_segments_v2/`, and `audiobooks_v1/` roots are purged by `pnpm migrate-decommission`.
- The playback sidecar prefix uses a hashed user id; audio uses the storage user id for content-addressed deduplication.

## Account Deletion Cleanup

Account deletion performs best-effort object cleanup:

- Document blobs + preview artifacts
- TTS playback audio and sidecar blobs

If object deletion fails, account deletion still proceeds and orphaned objects may require manual cleanup.

## TTS Playback Storage Debug Commands

Use these commands to inspect playback audio objects.

<Tabs groupId="tts-segment-storage-access-cli">
  <TabItem value="aws-s3" label="AWS S3" default>

```bash
# List all playback audio objects
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive

# Filter to one document id (replace <document-id>)
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive | grep "/docs/<document-id>/"
```

  </TabItem>
  <TabItem value="s3-compatible" label="Embedded / MinIO / R2 / etc">

```bash
# List all playback audio objects
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive --endpoint-url "$S3_ENDPOINT"

# Filter to one document id (replace <document-id>)
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive --endpoint-url "$S3_ENDPOINT" | grep "/docs/<document-id>/"
```

  </TabItem>
</Tabs>
