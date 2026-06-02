---
title: Other
---

Use any OpenAI-compatible TTS service with OpenReader, including self-hosted servers not covered by a dedicated guide.

## Requirements

Your service must expose these endpoints:

- `GET /v1/audio/voices`
- `POST /v1/audio/speech`

Known compatible implementations: [Kokoro-FastAPI](./kokoro-fastapi), [KittenTTS-FastAPI](./kitten-tts-fastapi), [Orpheus-FastAPI](./orpheus-fastapi).

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set `API_BASE` to your service base URL (typically ending in `/v1`).
3. Set API key if your service requires authentication.
4. Set a default model/voice supported by your backend.

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://your-tts-server/v1
API_KEY=optional-key-if-required
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

If voices don't load, check that `/v1/audio/voices` is reachable from the server and returns a valid response shape.

## References

- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
