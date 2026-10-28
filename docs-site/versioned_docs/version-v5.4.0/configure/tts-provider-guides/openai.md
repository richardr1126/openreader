---
title: OpenAI
---

Use the OpenAI TTS API as your provider.

## Setup

In **Settings → Admin → Providers**:

1. Add a provider with type **OpenAI**.
2. Keep base URL as `https://api.openai.com/v1`.
3. Enter your API key.
4. Set your preferred default model/voice.

**Or seed it on first boot** (see [Seed a provider from the environment](../tts-providers#seed-a-provider-from-the-environment)):

```env
API_BASE=https://api.openai.com/v1
API_KEY=sk-...
```

Users choose the provider, model and voice in **Settings → Model & Voice**.

## Notes

- Models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`
- Speech is requested by the compute worker, not the browser. The API key is never sent to browsers.

## References

- [OpenAI TTS pricing](https://platform.openai.com/docs/pricing#transcription-and-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
