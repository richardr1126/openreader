---
title: DeepInfra
---

Use DeepInfra's hosted TTS models as your provider.

## Setup

**Environment variables (recommended for deployment):**

```env
API_BASE=https://api.deepinfra.com/v1/openai
API_KEY=your-deepinfra-key
NEXT_PUBLIC_DEFAULT_TTS_PROVIDER=deepinfra
```

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Deepinfra`.
2. The base URL is pre-filled, no changes needed.
3. Enter your `API_KEY`.
4. Choose a model and voice.

Settings modal values override env vars. See [TTS Providers](../tts-providers) for how the two layers interact.

## Notes

- Available models include `hexgrad/Kokoro-82M` and `canopylabs/orpheus-3b-0.1-ft`.
- Without an API key, only the free-tier model (`hexgrad/Kokoro-82M`) is shown in the dropdown.
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [DeepInfra TTS models](https://deepinfra.com/models/text-to-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
