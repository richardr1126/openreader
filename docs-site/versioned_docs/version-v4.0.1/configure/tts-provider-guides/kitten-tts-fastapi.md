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

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Custom OpenAI-Like`.
2. Set `API_BASE` to your KittenTTS endpoint (e.g. `http://kittentts-fastapi:8005/v1`).
3. Leave `API_KEY` blank unless your deployment requires one.
4. Choose model `kitten-tts` (or the model your deployment exposes).

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

## References

- [richardr1126/KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
