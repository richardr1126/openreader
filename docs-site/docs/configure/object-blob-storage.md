---
title: Object / Blob Storage
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

This page documents storage backends, blob upload routing, and core Docker mount behavior.

## Storage backends

- Embedded (default): SQLite metadata + embedded SeaweedFS (`weed mini`) blobs.
- External: Postgres + external S3-compatible object storage.

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
- Read/download path: blob/content serving route `/api/documents/blob` (not the upload fallback route).
- Preview path: `/api/documents/blob/preview` (returns `202` while a preview is generating; serves/redirects when ready).

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

## Audiobook Storage Debug Commands

Audiobook assets are stored in object storage under the `audiobooks_v1` keyspace. Use these commands to inspect and download objects for debugging.

<Tabs groupId="audiobook-storage-access-cli">
  <TabItem value="aws-s3" label="AWS S3" default>

```bash
# List all audiobook objects
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/" --recursive

# Filter to one book id (replace <book-id>)
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/" --recursive | grep "<book-id>-audiobook/"

# Download one object by full key
aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/<path>/<file>.m4b" "./audiobook.m4b"
```

  </TabItem>
  <TabItem value="s3-compatible" label="Embedded / MinIO / R2 / etc">

```bash
# List all audiobook objects
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/" --recursive --endpoint-url "$S3_ENDPOINT"

# Filter to one book id (replace <book-id>)
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/" --recursive --endpoint-url "$S3_ENDPOINT" | grep "<book-id>-audiobook/"

# Download one object by full key
aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/audiobooks_v1/<path>/<file>.m4b" "./audiobook.m4b" --endpoint-url "$S3_ENDPOINT"
```

Embedded default example: `S3_ENDPOINT=http://127.0.0.1:8333` (or your mapped host/port).

  </TabItem>
</Tabs>
