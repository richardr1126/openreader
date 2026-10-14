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
2. Set the base URL for your deployment topology (Docker-to-host:
   `http://host.docker.internal:8005/v1`; native same-host: `http://127.0.0.1:8005/v1`).
3. Leave API key blank unless required by your deployment.
4. Set default model to `kitten-tts` (or your backend model id).

**Bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:8005/v1
```

> Use `host.docker.internal` only when OpenReader/its embedded worker run in Docker and KittenTTS
> runs on that Docker host. In Compose, use the provider service name on the shared network. A
> remote worker needs a public/private-network URL it can reach. See the
> [provider topology table](../tts-providers#custom-provider-requirements).

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [richardr1126/KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
