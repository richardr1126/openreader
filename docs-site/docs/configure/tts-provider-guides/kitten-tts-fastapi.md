---
title: KittenTTS-FastAPI
---

Run [KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider. Lightweight and CPU-friendly.

## Run KittenTTS

```bash
docker run -it --rm \
  --name kittentts-fastapi \
  -e KITTEN_MODEL_REPO_ID="KittenML/kitten-tts-nano-0.8-fp32" \
  -p 8005:8005 \
  ghcr.io/richardr1126/kittentts-fastapi-cpu
```

## Connect to OpenReader

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set base URL to your KittenTTS endpoint (e.g. `http://kittentts-fastapi:8005/v1`).
3. Leave API key blank unless required by your deployment.
4. Set default model to `kitten-tts` (or your backend model id).

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://kittentts-fastapi:8005/v1
```

> Use `kittentts-fastapi` if that's the container name, or `host.docker.internal` if not.

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [richardr1126/KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
