---
title: OpenAI
---

Use the OpenAI TTS API as your provider.

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `openai`.
2. Keep base URL as `https://api.openai.com/v1`.
3. Enter your API key.
4. Set your preferred default model/voice.

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=https://api.openai.com/v1
API_KEY=sk-...
```

**Per-user Settings → TTS Provider (only when `restrictUserApiKeys=false`):**

1. Set provider to `OpenAI`.
2. The base URL is pre-filled, no changes needed.
3. Enter your `API_KEY`.
4. Choose a model and voice.

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

## Notes

- Models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [OpenAI TTS pricing](https://platform.openai.com/docs/pricing#transcription-and-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
