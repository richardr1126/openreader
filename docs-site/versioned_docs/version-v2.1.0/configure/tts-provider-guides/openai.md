---
title: OpenAI
---

Use the OpenAI TTS API as your provider.

## Setup

**Environment variables (recommended for deployment):**

```env
API_BASE=https://api.openai.com/v1
API_KEY=sk-...
NEXT_PUBLIC_DEFAULT_TTS_PROVIDER=openai
```

**Or in-app via Settings → TTS Provider:**

1. Set provider to `OpenAI`.
2. The base URL is pre-filled, no changes needed.
3. Enter your `API_KEY`.
4. Choose a model and voice.

Settings modal values override env vars. See [TTS Providers](../tts-providers) for how the two layers interact.

## Notes

- Models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [OpenAI TTS pricing](https://platform.openai.com/docs/pricing#transcription-and-speech)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
