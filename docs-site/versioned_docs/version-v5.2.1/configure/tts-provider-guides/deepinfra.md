---
title: DeepInfra
---

Use DeepInfra's hosted TTS models as your provider.

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `deepinfra`.
2. Keep base URL as `https://api.deepinfra.com/v1/openai`.
3. Enter your API key.
4. Set your preferred default model/voice.

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=https://api.deepinfra.com/v1/openai
API_KEY=your-deepinfra-key
```

Users select the enabled shared provider, model, and voice from **Settings → TTS Provider**.

## Notes

- Available models include `hexgrad/Kokoro-82M` and `canopylabs/orpheus-3b-0.1-ft`.
- Without an API key, only the free-tier model (`hexgrad/Kokoro-82M`) is shown in the dropdown.
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [DeepInfra TTS models](https://deepinfra.com/models/text-to-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
