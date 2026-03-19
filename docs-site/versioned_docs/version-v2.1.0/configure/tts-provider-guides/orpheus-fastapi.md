---
title: Orpheus-FastAPI
---

Run [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider.

## Run Orpheus

Refer to the upstream repository for Docker instructions: [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI).

## Connect to OpenReader

**Environment variables (recommended for deployment):**

```env
API_BASE=http://orpheus:8000/v1
```

> Use the container name if that's how it's named, or `host.docker.internal` if not.

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Custom OpenAI-Like`.
2. Set `API_BASE` to your Orpheus endpoint (e.g. `http://orpheus:8000/v1`).
3. Leave `API_KEY` blank unless your deployment requires one.
4. Choose model `Orpheus` (or the model your deployment exposes).

Settings modal values override env vars. See [TTS Providers](../tts-providers) for how the two layers interact.

## References

- [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
