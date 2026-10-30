---
title: Object Storage
description: Where document files and generated audio are stored, and how browsers reach them.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Document files, generated audio, audiobooks and preview images live in object storage. The [database](./database) holds only their records.

## Embedded or external

| Backend | When it is used |
| --- | --- |
| **Embedded SeaweedFS** (default) | OpenReader starts `weed mini` itself and stores data under `docstore`. Its S3 endpoint listens on port `8333` inside the container; browsers never need to reach it. |
| **External S3-compatible** | Set `USE_EMBEDDED_WEED_MINI=false` with `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_INTERNAL_ENDPOINT` (for AWS, `https://s3.<region>.amazonaws.com`), plus a [browser transport](#how-browsers-reach-files). Works with AWS S3, Cloudflare R2, MinIO, an external SeaweedFS and similar. |

Every variable is listed in [Environment Variables](../reference/environment-variables#database-and-object-blob-storage).

### Persist and back up `docstore`

In Docker, mount a volume at `/app/docstore`:

```bash
-v openreader_docstore:/app/docstore
```

It holds the embedded storage, the SQLite database and temporary files. Embedded SeaweedFS encrypts every object with a key kept in the same directory (`.mini_sse_kek`), so back up the whole volume. The object files cannot be read without that key.

The full Compose stacks keep storage in the `seaweedfs-data` volume instead. Back it up together with `examples/docker/.env`, which may hold its key as `WEED_S3_SSE_KEK` (see [Docker Compose](../deploy/docker-compose#full-stacks-from-530-or-earlier)).

## How browsers reach files

`S3_BROWSER_TRANSPORT` decides how browsers upload and download files:

| Value | Behavior |
| --- | --- |
| `proxy` | Browsers go through OpenReader's own routes. The default for embedded storage. |
| `presigned` | Browsers use signed URLs to `S3_PUBLIC_ENDPOINT` directly. The app and worker still use `S3_INTERNAL_ENDPOINT`. |
| `auto` | `proxy` for embedded storage; otherwise `presigned`, which requires a public HTTPS `S3_PUBLIC_ENDPOINT`. |

A failed direct transfer is not retried through the proxy.

For `presigned`, give the bucket its own HTTPS hostname, such as `s3.reader.example`, rather than a path like `/s3`. Your reverse proxy must keep the signed path, query string, `Host` and signed headers unchanged. Configure CORS for the OpenReader address with `GET`, `HEAD`, `PUT` and `OPTIONS`, allowing the `Content-Type` and `x-amz-server-side-encryption` headers.

## What is stored

All keys are under `S3_PREFIX`.

| Prefix | Contents | Kept until |
| --- | --- | --- |
| `documents_v1/` | Uploaded documents, named by SHA-256 so identical files are stored once. Each upload is read back and its hash checked before it is added to the library. | No document references it ([Clean up unowned documents](./maintenance#scheduled-tasks)). |
| `document_uploads_temp_v1/` | Uploads in progress. | Finished, or expired ([Clean up expired uploads](./maintenance#scheduled-tasks)). |
| `document_previews_v1/` | Library thumbnails for PDF and EPUB. | The document is deleted. They can be regenerated. |
| `tts_playback_segments_audio_v1/` | Generated speech, one file per segment. | The user clears audio or deletes the document. |
| `tts_playback_segments_v1/`, `tts_playback_plan_v1/` | Word timings and the playback plan for each document and voice. | Same as the audio. |
| `tts_playback_exports_v1/` | Finished audiobooks and temporary account export ZIPs. | Audiobooks: until audio is cleared. Export ZIPs: seven days. |

Deleting an account removes its documents, previews and audio first. If that fails, the account is kept so the deletion can be retried.

Browsers also keep copies of documents, previews and audio in Cache Storage (`openreader-blobs-v1`) to load faster. It is only a cache; clearing it loses nothing.

## Inspect playback audio

<Tabs groupId="tts-segment-storage-access-cli">
  <TabItem value="aws-s3" label="AWS S3" default>

```bash
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive | grep "/docs/<document-id>/"
```

  </TabItem>
  <TabItem value="s3-compatible" label="Embedded / MinIO / R2 / etc">

```bash
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/tts_playback_segments_audio_v1/" --recursive --endpoint-url "$S3_INTERNAL_ENDPOINT" | grep "/docs/<document-id>/"
```

  </TabItem>
</Tabs>
