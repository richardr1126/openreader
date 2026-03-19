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

**Environment variables (recommended for deployment):**

```env
API_BASE=http://kokoro-tts:8880/v1
```

> Use `kokoro-tts` if that's the container name, or `host.docker.internal` if not.

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Custom OpenAI-Like`.
2. Set `API_BASE` to your Kokoro endpoint (e.g. `http://kokoro-tts:8880/v1`).
3. Leave `API_KEY` blank unless your deployment requires one.
4. Choose model `Kokoro`.

Settings modal values override env vars. See [TTS Providers](../tts-providers) for how the two layers interact.

## References

- [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
