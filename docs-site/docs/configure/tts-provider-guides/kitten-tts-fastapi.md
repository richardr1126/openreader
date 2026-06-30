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
2. Set base URL to `http://host.docker.internal:8005/v1`.
3. Leave API key blank unless required by your deployment.
4. Set default model to `kitten-tts` (or your backend model id).

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:8005/v1
```

> Use `host.docker.internal` so the OpenReader container reaches KittenTTS's published port on your host. The container name (`kittentts-fastapi`) only resolves if OpenReader and KittenTTS share a Docker network, i.e. you started them with Docker Compose, `--link kittentts-fastapi`, or a shared `--network`. On native Linux Docker, `host.docker.internal` needs `--add-host=host.docker.internal:host-gateway` on the OpenReader container. Note that `localhost`/`127.0.0.1` will not work, since inside the container that points at the container itself.

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [richardr1126/KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
