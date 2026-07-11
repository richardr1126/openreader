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
- `8333`: embedded SeaweedFS S3 endpoint for app/worker storage traffic

:::info
The embedded default uses same-origin OpenReader proxy routes, so `8333` does not need to be exposed to browsers.
:::

## Upload behavior

OpenReader chooses one browser transport before every transfer with `S3_BROWSER_TRANSPORT`; it never retries a failed direct request through the app proxy.

- `proxy` (the embedded default): uploads use `/api/documents/blob/upload`, reads use `/api/documents/blob/get`, and previews use `/api/documents/blob/preview`.
- `presigned`: browser transfers use signatures generated from `S3_PUBLIC_ENDPOINT`. The server and compute worker still use `S3_INTERNAL_ENDPOINT`.
- `auto`: chooses `proxy` for embedded SeaweedFS, otherwise requires a public HTTPS `S3_PUBLIC_ENDPOINT` and chooses `presigned`.

`S3_ENDPOINT` is a deprecated compatibility alias. Configure `S3_INTERNAL_ENDPOINT` and, for direct browser storage, `S3_PUBLIC_ENDPOINT` instead.

For a public SeaweedFS/S3 origin, use a dedicated HTTPS hostname such as `s3.reader.example`, not a `/s3` path mount. Preserve the signed path, query string, `Host`, and signed headers in the reverse proxy. Configure CORS for the OpenReader origin with `GET`, `HEAD`, `PUT`, and `OPTIONS`, allowing `Content-Type` and `x-amz-server-side-encryption`.

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

## Transport topology

The default embedded topology is `Browser → OpenReader → http://127.0.0.1:8333 SeaweedFS`. For public object storage, use `Browser → https://s3.example → S3/SeaweedFS` and configure the app and worker with a private `S3_INTERNAL_ENDPOINT`.

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
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive --endpoint-url "$S3_INTERNAL_ENDPOINT"

# Filter to one document id (replace <document-id>)
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive --endpoint-url "$S3_INTERNAL_ENDPOINT" | grep "/docs/<document-id>/"
```

  </TabItem>
</Tabs>
