---
title: Replicate
---

Use Replicate's hosted TTS models as your provider.

## Setup

In **Settings → Admin → Providers**:

1. Add a provider with type **Replicate**.
2. Enter your API key.
3. Set default model to:
   `google/gemini-3.1-flash-tts` (or your preferred model).

Users choose the provider, model and voice in **Settings → Model & Voice**.

## Notes

- Built-in Replicate models:
  - `google/gemini-3.1-flash-tts`
  - `minimax/speech-2.8-turbo`
  - `qwen/qwen3-tts`
  - `inworld/realtime-tts-1.5-mini`
- Existing `inworld/tts-1.5-mini` settings run through the renamed model. Saved settings and audio cache identities are preserved; no migration is required.
- The former hosted Kokoro option is retired because of slow cold starts. Existing selections require another model for new generation; saved audio and settings are retained. New Replicate setups default to Gemini 3.1 Flash TTS with Zephyr. Local Kokoro and DeepInfra Kokoro remain available.
- You can also choose `Other` and enter any Replicate model ID (for example `owner/model-name` or `owner/model-name:version`).
- Native model speed is not available on all Replicate models; OpenReader hides/disables native speed controls where unsupported.
- Speech is requested by the compute worker, not the browser. The API key is never sent to browsers.

## References

- [Replicate](https://replicate.com/explore)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
