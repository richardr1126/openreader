---
title: Orpheus-FastAPI
---

Run [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider.

## Run Orpheus

Refer to the upstream repository for Docker instructions: [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI).

## Connect to OpenReader

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set the base URL for your deployment topology (Docker-to-host:
   `http://host.docker.internal:8000/v1`; native same-host: `http://127.0.0.1:8000/v1`).
3. Leave API key blank unless required by your deployment.
4. Set default model to `Orpheus` (or your backend model id).

**Bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:8000/v1
```

> Use `host.docker.internal` only when OpenReader/its embedded worker run in Docker and Orpheus runs
> on that Docker host. In Compose, use the provider service name on the shared network. A remote
> worker needs a public/private-network URL it can reach. See the
> [provider topology table](../tts-providers#custom-provider-requirements).

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
