---
title: OpenAI
---

Use OpenAI directly as an OpenAI-compatible TTS provider.

## Provider

- Provider: `OpenAI`
- Default endpoint: `https://api.openai.com/v1` (auto-filled)
- `API_KEY`: required for OpenAI access

## OpenReader setup

1. In OpenReader Settings, choose provider `OpenAI`.
2. Keep the default `API_BASE`.
3. Set `API_KEY`.
4. Choose your model and voice.

## Notes

:::tip Built-in endpoint
`OpenAI` is a built-in provider, so OpenReader auto-fills the default `API_BASE`.
:::

:::info Server-side requests
OpenReader sends TTS requests from the server runtime, not directly from the browser.
:::

## References

- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
