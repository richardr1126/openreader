---
title: TTS Rate Limiting
---

This page explains OpenReader's TTS character rate limiting controls.

## Overview

- TTS rate limiting is disabled by default.
- Primary control is **Settings → Admin → Site features → Disable TTS daily rate limiting**.
- Optional first-boot seed: `RUNTIME_SEED_DISABLE_TTS_LIMIT=true`.
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

## Runtime config + seed var

- First-boot seed toggle: `RUNTIME_SEED_DISABLE_TTS_LIMIT` (default: `true`)
- Per-user and IP backstop limit values are configured in **Settings → Admin → Site features** and stored in DB runtime settings.

## Related docs

- TTS/rate-limit environment variables: [Environment Variables](../reference/environment-variables#tts-provider-and-request-behavior)
- PDF parsing rate limiting (separate, compute-side throttle): [Admin Panel → Site features](./admin-panel#site-features) and [Environment Variables](../reference/environment-variables#compute-pdf-parsing-rate-limiting-runtime-settings)
- Auth configuration: [Auth](./auth)
- Provider setup: [TTS Providers](./tts-providers)
