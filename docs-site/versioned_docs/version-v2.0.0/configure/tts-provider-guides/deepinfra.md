---
title: Deepinfra
---

Use Deepinfra as a hosted OpenAI-compatible TTS provider.

## Provider

- Provider: `Deepinfra`
- Default endpoint: `https://api.deepinfra.com/v1/openai` (auto-filled)
- `API_KEY`: required for authenticated DeepInfra usage

## OpenReader setup

1. In OpenReader Settings, choose provider `Deepinfra`.
2. Keep the default `API_BASE`.
3. Set `API_KEY`.
4. Choose your model and voice.

## Notes

:::tip Built-in endpoint
`Deepinfra` is a built-in provider, so OpenReader auto-fills the default `API_BASE`.
:::

:::info Model support
DeepInfra exposes multiple TTS models, including Kokoro-family options.
:::

## References

- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
