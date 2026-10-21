---
title: DeepInfra
---

Use DeepInfra's hosted TTS models as your provider.

## Setup

In **Settings → Admin → Providers**:

1. Add a provider with type **Deepinfra**.
2. Keep base URL as `https://api.deepinfra.com/v1/openai`.
3. Enter your API key.
4. Set your preferred default model/voice.

**Or seed it on first boot** (see [Seed a provider from the environment](../tts-providers#seed-a-provider-from-the-environment)):

```env
API_BASE=https://api.deepinfra.com/v1/openai
API_KEY=your-deepinfra-key
```

Users choose the provider, model and voice in **Settings → Model & Voice**.

## Notes

- Available models include `hexgrad/Kokoro-82M` and `canopylabs/orpheus-3b-0.1-ft`.
- Without an API key, only the free-tier model (`hexgrad/Kokoro-82M`) is shown in the dropdown.
- Speech is requested by the compute worker, not the browser. The API key is never sent to browsers.

## References

- [DeepInfra TTS models](https://deepinfra.com/models/text-to-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
