---
title: Replicate
---

Use Replicate's hosted TTS models as your provider.

## Setup

In **Settings → Admin → Providers**:

1. Add a provider with type **Replicate**.
2. Enter your API key.
3. Set default model to:
   `alphanumericuser/kokoro-82m:89b6fa84e4fa2dd6bd3a96be3e1f12827a3516c9fda8fddbac7a0be131c9a6f5` (or your preferred model).

**Or seed it on first boot** (see [Seed a provider from the environment](../tts-providers#seed-a-provider-from-the-environment)):

```env
API_KEY=r8_...
```

Then change the provider's **Default model** in **Settings → Admin → Providers**.

Users choose the provider, model and voice in **Settings → Model & Voice**.

## Notes

- Built-in Replicate models:
  - `alphanumericuser/kokoro-82m:89b6fa84e4fa2dd6bd3a96be3e1f12827a3516c9fda8fddbac7a0be131c9a6f5`
  - `google/gemini-3.1-flash-tts`
  - `minimax/speech-2.8-turbo`
  - `qwen/qwen3-tts`
  - `inworld/tts-1.5-mini`
- You can also choose `Other` and enter any Replicate model ID (for example `owner/model-name` or `owner/model-name:version`).
- Native model speed is not available on all Replicate models; OpenReader hides/disables native speed controls where unsupported.
- Speech is requested by the compute worker, not the browser. The API key is never sent to browsers.

## References

- [Replicate](https://replicate.com/explore)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
