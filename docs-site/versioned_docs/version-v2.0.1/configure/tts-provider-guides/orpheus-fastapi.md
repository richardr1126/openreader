---
title: Orpheus-FastAPI
---

Use Orpheus-FastAPI as an OpenAI-compatible TTS backend for OpenReader.

## Provider

- Provider: `Custom OpenAI-Like`
- Typical model: `Orpheus`
- `API_BASE`: required (usually your Orpheus URL ending with `/v1`)
- `API_KEY`: set only if your deployment requires one

## OpenReader setup

1. Start your Orpheus-FastAPI server.
2. In OpenReader Settings, choose provider `Custom OpenAI-Like`.
3. Set `API_BASE` to your Orpheus base URL (typically ending with `/v1`).
4. Set `API_KEY` only if your Orpheus deployment requires one.
5. Choose model `Orpheus` (or another model exposed by your deployment).

## Notes

:::info OpenAI-compatible API
OpenReader expects OpenAI-compatible audio endpoints when using Orpheus through `Custom OpenAI-Like`.
:::

:::tip Endpoint shape
Use an `API_BASE` that points at the Orpheus API root (typically ending with `/v1`).
:::

## References

- [Lex-au/Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
