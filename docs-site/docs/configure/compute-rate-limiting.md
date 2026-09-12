---
title: Compute Rate Limiting
---

OpenReader uses one versioned policy document for user admission, metered TTS usage, worker scheduling, resource capacity, and TTS-provider throughput.

## Covered work

The policy has independently configurable entries for PDF layout analysis, live TTS playback, TTS plan creation, audiobook assembly, document previews, document conversion, account export, and TTS segment synthesis. Each user or provider limit has a direct enabled switch: enabled limits enforce their configured values, while disabled limits are bypassed.

The complete policy is available in **Settings → Admin → Site features → Rate limiting**. The form exposes every admission window, active lease, usage threshold, queue, worker resource, and provider capacity value. Named provider overrides can be added for different service plans.

## TTS character thresholds

TTS usage is measured at the segment that actually needs provider synthesis:

- Cached segments are free.
- A missing segment is checked immediately before its provider call.
- If usage starts below the daily threshold, that complete segment is generated and charged even if it crosses the threshold.
- The next missing segment stops. Playback can finish the audio already generated.
- One stable event key makes retries and redelivery free of duplicate charges.

The self-host default enables only these generated-character thresholds, preserving separate anonymous and authenticated user/IP thresholds plus an anonymous-device backstop. Resets occur at midnight UTC.

Users can see their generated-character usage and reset timing in **Settings → Account**. The reader controls remain available after the threshold is reached so cached audio can still be played and sought normally.

## Other limits

- Admission windows cap how frequently users can start each compute action.
- Active leases cap concurrent user and site work and recover automatically after crashes.
- Worker concurrency, per-action queues, priorities, and named CPU/model/FFmpeg/LibreOffice/archive resources protect each worker.
- Provider concurrency and rolling request/character limits are coordinated across worker replicas through JetStream KV.
- Live playback keeps up to three ordered segment requests ready, while the provider's configurable **Max concurrent** value remains the actual cross-worker limit. The self-host default of three restores useful playback runway; lower it for a server that cannot synthesize requests in parallel.
- Provider `429 Retry-After` responses cool down that provider's shared capacity bucket.
- All operation admission limits are disabled by default for self-hosted installations. The configured values remain available as an opt-in for public or shared installations.
- New-generation character limits remain enabled by default and stop only uncached provider work at a segment boundary.

The application owns SQL admission and usage decisions. The worker owns local execution scheduling and provider capacity. No database two-phase commit is used.

## Storage and seeding

`compute_limit_admissions`, `compute_limit_buckets`, and `compute_limit_events` hold the app-owned limiter state. The v5 migration intentionally drops the retired `user_tts_chars` and `user_job_events` tables and starts users with fresh usage.

Use `RUNTIME_SEED_JSON` or `RUNTIME_SEED_JSON_PATH` to seed `runtimeConfig.computeLimitPolicies`. The complete maintained example is `examples/openreader-seed.json`; unknown or incomplete policy fields make the seed fail before any setting is written.

## Related docs

- [Admin Panel](./admin-panel#rate-limiting)
- [Environment Variables](../reference/environment-variables#runtime-json-seed)
- [Auth](./auth)
- [TTS Providers](./tts-providers)
