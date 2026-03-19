---
title: TTS Rate Limiting
---

This page explains OpenReader's TTS character rate limiting controls.

## Overview

- TTS rate limiting is disabled by default.
- To enable it, set `TTS_ENABLE_RATE_LIMIT=true`.
- Limits are enforced per day in UTC.
- Enforcement applies only when auth is enabled.

## How enforcement works

When enabled, OpenReader enforces:

- Per-user daily character limits.
- IP backstop daily character limits.
- Anonymous device backstop tracking (cookie-based) to reduce limit resets.

If a request exceeds the active limit, the TTS API returns `429` with reset metadata for the next UTC day.

## Required auth behavior

- Auth must be enabled (`BASE_URL` + `AUTH_SECRET`) for TTS char limits to apply.
- If auth is disabled, TTS character limits are effectively unlimited.
- `DISABLE_AUTH_RATE_LIMIT` only affects Better Auth's own request throttling.
- `DISABLE_AUTH_RATE_LIMIT` does not disable TTS character limits.

## Environment variables

Enable/disable:

- `TTS_ENABLE_RATE_LIMIT` (default: `false`)

Per-user daily limits:

- `TTS_DAILY_LIMIT_ANONYMOUS` (default: `50000`)
- `TTS_DAILY_LIMIT_AUTHENTICATED` (default: `500000`)

IP backstop daily limits:

- `TTS_IP_DAILY_LIMIT_ANONYMOUS` (default: `100000`)
- `TTS_IP_DAILY_LIMIT_AUTHENTICATED` (default: `1000000`)

## Related docs

- TTS/rate-limit environment variables: [Environment Variables](../reference/environment-variables#tts-provider-and-request-behavior)
- Auth configuration: [Auth](./auth)
- Provider setup: [TTS Providers](./tts-providers)
