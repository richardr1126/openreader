---
title: Kokoro-FastAPI
---

Run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider.

:::warning
For Kokoro issues and support, use the upstream repository: [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI).
:::

## Run Kokoro

Use the upstream images; their README is the source of truth for tags and options. These commands
follow it at the time of writing.

**CPU (any machine):**

```bash
docker run --name kokoro-tts --restart unless-stopped -d \
  -p 8880:8880 \
  ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

**GPU (NVIDIA, needs the NVIDIA Container Toolkit):**

```bash
docker run --name kokoro-tts --restart unless-stopped -d \
  --gpus all \
  -p 8880:8880 \
  ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

`gpu:latest` ships CUDA 12.6 on amd64 and CUDA 12.9 on arm64 (Jetson, GH200). For Blackwell/RTX
50-series GPUs on amd64, use `ghcr.io/remsky/kokoro-fastapi-gpu:latest-cu128` instead. Docker GPU images do not run on Apple
Silicon; use the CPU image there.

Pin a release tag (for example `v0.9.0`) instead of `latest` if you want upgrades to be deliberate.

**Check that it is running** before connecting OpenReader:

```bash
curl http://localhost:8880/v1/audio/voices
```

## Connect to OpenReader

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set the base URL for your deployment topology (Docker-to-host:
   `http://host.docker.internal:8880/v1`; native same-host: `http://127.0.0.1:8880/v1`).
3. Leave API key blank unless required by your deployment.
4. Set default model to `Kokoro`.

**Bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:8880/v1
API_MODEL_NAME=kokoro
```

> Use `host.docker.internal` only when OpenReader/its embedded worker run in Docker and Kokoro runs
> on that Docker host. In Compose, use the shared service URL `http://kokoro-tts:8880/v1`.
> A remote worker needs a public/private-network URL it can reach. See the
> [provider topology table](../tts-providers#custom-provider-requirements).

Users select the configured shared provider, model, and voice from **Settings → TTS Provider**.

## References

- [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
