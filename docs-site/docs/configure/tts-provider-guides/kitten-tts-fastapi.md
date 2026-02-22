---
title: KittenTTS-FastAPI
---

Use [KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI) as an OpenAI-compatible TTS backend for OpenReader.

## Provider

- Provider: `Custom OpenAI-Like`
- Typical model: `kitten-tts`
- `API_BASE`: required (usually your KittenTTS URL ending with `/v1`)
- `API_KEY`: set only if your deployment requires one

## Run KittenTTS (CPU)

```bash
docker run -it --rm \
  --name kittentts-fastapi \
  -e KITTEN_MODEL_REPO_ID="KittenML/kitten-tts-nano-0.8-fp32" \
  -p 8005:8005 \
  ghcr.io/richardr1126/kittentts-fastapi-cpu
```

## OpenReader setup

1. Start your KittenTTS-FastAPI server.
2. In OpenReader Settings, choose provider `Custom OpenAI-Like`.
3. Set `API_BASE` to your KittenTTS base URL (typically ending with `/v1`).
4. Set `API_KEY` only if your deployment requires one.
5. Choose model `kitten-tts` (or another model exposed by your deployment).

## Notes

:::info OpenAI-compatible API
OpenReader expects OpenAI-compatible audio endpoints when using KittenTTS through `Custom OpenAI-Like`.
:::

:::tip Endpoint shape
Use an `API_BASE` that points at the KittenTTS API root (typically ending with `/v1`).
:::

## References

- [richardr1126/KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
