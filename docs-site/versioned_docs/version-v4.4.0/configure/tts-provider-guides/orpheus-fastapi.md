---
title: Orpheus-FastAPI
---

Run [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider.

## Run Orpheus

Refer to the upstream repository for Docker instructions: [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI).

## Connect to OpenReader

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set base URL to `http://host.docker.internal:8000/v1`.
3. Leave API key blank unless required by your deployment.
4. Set default model to `Orpheus` (or your backend model id).

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:8000/v1
```

> Use `host.docker.internal` so the OpenReader container reaches Orpheus's published port on your host. The container name (`orpheus`) only resolves if OpenReader and Orpheus share a Docker network, i.e. you started them with Docker Compose, `--link orpheus`, or a shared `--network`. On native Linux Docker, `host.docker.internal` needs `--add-host=host.docker.internal:host-gateway` on the OpenReader container. Note that `localhost`/`127.0.0.1` will not work, since inside the container that points at the container itself.

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
