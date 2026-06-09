---
title: Other
---

Use any OpenAI-compatible TTS service with OpenReader, including self-hosted servers not covered by a dedicated guide.

## Requirements

Your service only needs an OpenAI-compatible speech endpoint:

- `POST /v1/audio/speech` — **required**.
- Voice listing is **optional** and auto-discovered from `/v1/audio/voices`, `/v1/voices`, or `/v1/styles`. If none respond, OpenReader falls back to default voices — the Kokoro voice set for Kokoro models, otherwise the standard OpenAI voices (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).

The endpoint may return `mp3`, `wav`, `ogg`, or `flac` — OpenReader normalizes non-mp3 audio to mp3 automatically. An API key is optional.

Known compatible implementations: [Kokoro-FastAPI](./kokoro-fastapi), [KittenTTS-FastAPI](./kitten-tts-fastapi), [Orpheus-FastAPI](./orpheus-fastapi), [Supertonic](./supertonic).

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set `API_BASE` to your service base URL (typically ending in `/v1`).
3. Set API key if your service requires authentication.
4. Set a default model/voice supported by your backend.

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://your-tts-server/v1
# API_KEY=optional-key-if-required
```

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Custom OpenAI-Like`.
2. Set `API_BASE` to your service's base URL (typically ending in `/v1`).
3. Set `API_KEY` if your service requires authentication.
4. Choose a model and voice supported by your backend.

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

:::warning TTS requests are server-side
`API_BASE` must be reachable from the **Next.js server**, not just the browser. In Docker, use container names or `host.docker.internal`.
:::

## Troubleshooting

If voices don't load, confirm the server is reachable from the Next.js runtime and that at least one of `/v1/audio/voices`, `/v1/voices`, or `/v1/styles` returns a valid response. If none do, OpenReader falls back to default voices — synthesis still works as long as `POST /v1/audio/speech` succeeds.

## References

- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
