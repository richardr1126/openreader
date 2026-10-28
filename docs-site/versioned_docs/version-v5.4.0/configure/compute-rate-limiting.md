---
title: Compute and Rate Limits
description: Upload size, per-user limits, and TTS generation tuning in Settings → Admin → Compute.
---

**Settings → Admin → Compute** controls how much work the compute worker accepts and how speech generation behaves. As with [instance settings](./instance-settings), each setting shows its source, can be reset, and can be seeded with `RUNTIME_SEED_JSON`.

## Limits

| Setting | Key | What it does |
| --- | --- | --- |
| **Max upload size** | `maxUploadMb` | The largest document one upload may be, in MB. |
| Compute limits | `computeLimitPolicies` | Per-user, site, worker and provider limits for every kind of compute work. Not shown in the desktop app. |

Every limit is off by default on a self-hosted install. Turn them on when you run a public or shared instance.

The compute limits cover PDF layout analysis, live playback, audiobook export, document previews, DOCX conversion, account export and TTS generation. Each kind of work has its own switch, and its own:

- **start windows**: how often one user, or the whole site, can start it;
- **active work**: how many can run at once, which recovers automatically after a crash;
- **queue and concurrency**: queue length, priority and parallel jobs per worker, plus CPU, model, FFmpeg, LibreOffice and archive capacity.

**Provider limits** cap concurrent requests and the request and character rates sent to each provider, across all worker replicas. Add named overrides for providers on a different service plan. A provider's `429 Retry-After` response pauses requests to that provider. **Max concurrent** is the number of segments generated in parallel for live playback. The default of three keeps playback ahead of the listener; lower it for a server that can only handle one request at a time.

### Daily character limits

TTS usage is counted in characters sent to a provider, and only for audio that has to be generated. Replaying cached audio is always free.

- Before each missing segment is generated, OpenReader checks the user's usage. A segment that starts below the limit is finished and counted even if it crosses the limit; the next one stops.
- Playback can continue through audio that is already generated, and seeking still works.
- Retries never count twice.

Separate limits apply to signed-in users, guests, and each IP address, plus a backstop per guest device. They reset at midnight UTC. Users see their usage in **Settings → Account**, and admins see it per user in **Users**.

The complete policy, with every value, is in [`examples/openreader-seed.json`](https://github.com/richardr1126/openreader/blob/main/examples/openreader-seed.json). An incomplete or unknown policy in a seed stops startup before anything is written.

## TTS generation

| Setting | Key | What it does |
| --- | --- | --- |
| **Background generation** | `ttsPlaybackBackgroundExtent` | How far the worker keeps generating after the reader stops reporting its position: to the end of the current page or chapter (**Current section**, the default) or to the end of the document (**Full document**). |
| **Retry attempts** | `ttsUpstreamMaxRetries` | How many times a failed provider request (429 or 5xx) is retried before the segment fails. |
| **Upstream timeout** | `ttsUpstreamTimeoutMs` | How long to wait for a provider response. |
| **Audio cache size** | `ttsCacheMaxSizeBytes` | The worker's in-memory cache of recently generated audio. |
| **Audio cache TTL** | `ttsCacheTtlMs` | How long audio stays in that cache. |

Generated audio is also stored permanently in object storage, so these cache settings only affect speed, not what is kept.
