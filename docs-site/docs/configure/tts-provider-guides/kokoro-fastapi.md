---
title: Kokoro-FastAPI
---

You can run the Kokoro TTS API server directly with Docker.

:::warning
For Kokoro issues and support, use the upstream repository: [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI).
:::

## Provider

- Provider: `Custom OpenAI-Like`
- Typical model: `Kokoro`
- `API_BASE`: required (typically your Kokoro URL ending with `/v1`)
- `API_KEY`: set only if your deployment requires one

## Run Kokoro (CPU)

```bash
docker run -d \
  --name kokoro-tts \
  --restart unless-stopped \
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

## Run Kokoro (GPU)

```bash
docker run -d \
  --name kokoro-tts \
  --gpus all \
  --user 1001:1001 \
  --restart unless-stopped \
  -p 8880:8880 \
  -e USE_GPU=true \
  -e PYTHONUNBUFFERED=1 \
  -e API_LOG_LEVEL=DEBUG \
  ghcr.io/remsky/kokoro-fastapi-gpu:v0.2.4
```

## OpenReader setup

1. Start Kokoro using either the CPU or GPU image.
2. In OpenReader Settings, choose provider `Custom OpenAI-Like`.
3. Set `API_BASE` to your Kokoro endpoint (for Docker Compose, commonly `http://kokoro-tts:8880/v1`).
4. Set `API_KEY` only if your deployment requires one.
5. Choose model `Kokoro`.

## Notes

:::tip Runtime guidance
GPU mode requires NVIDIA Docker support and is best on NVIDIA hardware. CPU mode is a good default on Apple Silicon and modern x86 CPUs.
:::

## References

- [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
