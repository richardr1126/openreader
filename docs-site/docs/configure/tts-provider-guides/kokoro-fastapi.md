---
title: Kokoro-FastAPI
---

Run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider.

:::warning
For Kokoro issues and support, use the upstream repository: [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI).
:::

## Run Kokoro

**CPU:**

```bash
docker run --name kokoro-tts \
  --restart unless-stopped \
  -d \
  -p 8880:8880 \
  -e ONNX_NUM_THREADS=8 \
  -e ONNX_INTER_OP_THREADS=4 \
  -e ONNX_EXECUTION_MODE=parallel \
  -e ONNX_OPTIMIZATION_LEVEL=all \
  -e ONNX_MEMORY_PATTERN=true \
  -e ONNX_ARENA_EXTEND_STRATEGY=kNextPowerOfTwo \
  -e API_LOG_LEVEL=DEBUG \
  ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4
```

**GPU (NVIDIA):**

```bash
docker run --name kokoro-tts \
  --restart unless-stopped \
  -d \
  --gpus all \
  --user 1001:1001 \
  -p 8880:8880 \
  -e USE_GPU=true \
  -e PYTHONUNBUFFERED=1 \
  -e API_LOG_LEVEL=DEBUG \
  ghcr.io/remsky/kokoro-fastapi-gpu:v0.2.4
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
