---
title: Compute and Rate Limits
description: Upload size, per-user limits, and TTS generation tuning in Settings → Admin → Compute.
---

**Settings → Admin → Compute** controls how much work the compute worker accepts and how speech generation behaves. As with [instance settings](./instance-settings), each setting shows its source, can be reset, and can be seeded with `RUNTIME_SEED_JSON`.

## Limits

| Setting | Key | What it does |
| --- | --- | --- |
| **Max upload size** | `maxUploadMb` | The largest document one upload may be, in MB. |
| **Storage per account** | `limitAccountStorage`, `accountStorageMb` | Optional total for documents and audio. Off by default; enabling reveals 10,240 MB. |
| **Storage per guest** | `limitGuestStorage`, `guestStorageMb` | Separate guest total. Off by default; enabling reveals 1,024 MB. |
| **Total guest storage** | `limitGuestStoragePool`, `guestStoragePoolMb` | Shared pool for all guests. Off by default; enabling reveals 10,240 MB. Accounts are unaffected. |
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

Separate per-user limits apply to signed-in users and guests. They reset at midnight UTC. Users see their usage in **Settings → Account**, and admins see it per user in **Users**. Optional creation caps under **Instance** limit new accounts per IP over a rolling period and new guests per IP over the guest idle period. IPv6 addresses share a /64 bucket; stored IP values are keyed hashes. Existing accounts keep working when a creation cap is reached.

The complete policy, with every value, is in [`examples/openreader-seed.json`](https://github.com/richardr1126/openreader/blob/main/examples/openreader-seed.json). An incomplete or unknown policy in a seed stops startup before anything is written.

### Storage and daily files

**New documents** uses the `document_intake` policy. It is off by default;
enabling it reveals 10 daily files per guest and 100 per account. Each upload
preparation, text import or URL import counts once, including failed imports.
URL imports check the allowance before fetching. The allowance resets at midnight
UTC and has no worker execution block. Saved policies gain this action's defaults.

**Settings → Storage**, the admin user list and storage caps share one SQL total:
source document sizes plus generated segment audio, timing sidecars and exports.
Shared parsed layouts, previews and plans do not count. The worker measures the
affected document during generation, when a run finishes and after audio deletion;
opening settings never scans storage. The document settings panel still measures
one document to separate audio by voice/settings and show shared derived data.

Upload preparation checks the projected total, and registration checks again
under a transaction so concurrent uploads cannot bypass a cap. New audio checks
the latest measured total before each uncached segment, even with character
limits off. Measurements are periodic and in-flight segments can finish, so an
audio run can cross the byte threshold before stopping. Cached audio remains
playable. Blocked actions link to Storage to free space; guests can create an
account when sign-ups are open.

Run **Repair storage usage** in Maintenance after upgrading to backfill existing
audio before enabling caps. Its first run covers all users; later runs repair
users active in the last seven days. Failed reports leave the previous total
until a later run repairs it. Audio left by a removed document still counts until
its queued cleanup or Reclaim orphaned audio removes it.

## TTS generation

| Setting | Key | What it does |
| --- | --- | --- |
| **Background generation** | `ttsPlaybackBackgroundExtent` | How far the worker keeps generating after the reader stops reporting its position: to the end of the current page or chapter (**Current section**, the default) or to the end of the document (**Full document**). |
| **Retry attempts** | `ttsUpstreamMaxRetries` | How many times a failed provider request (429 or 5xx) is retried before the segment fails. |
| **Upstream timeout** | `ttsUpstreamTimeoutMs` | How long to wait for a provider response. |
| **Audio cache size** | `ttsCacheMaxSizeBytes` | The worker's in-memory cache of recently generated audio. |
| **Audio cache TTL** | `ttsCacheTtlMs` | How long audio stays in that cache. |

Generated audio is also stored permanently in object storage, so these cache settings only affect speed, not what is kept.
