---
title: Replicate
---

Use Replicate's hosted TTS models as your provider.

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `replicate`.
2. Enter your API key.
3. Set default model to:
   `alphanumericuser/kokoro-82m:89b6fa84e4fa2dd6bd3a96be3e1f12827a3516c9fda8fddbac7a0be131c9a6f5` (or your preferred model).

**Legacy bootstrap seed (optional, first boot only):**

```env
API_KEY=r8_...
```

Then update the shared provider's **Default model** in **Settings → Admin → Shared providers**.

**Per-user Settings → TTS Provider (only when `restrictUserApiKeys=false`):**

1. Set provider to `Replicate`.
2. Enter your `API_KEY`.
3. Choose a model and voice.

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

## Notes

- Built-in Replicate models:
  - `alphanumericuser/kokoro-82m:89b6fa84e4fa2dd6bd3a96be3e1f12827a3516c9fda8fddbac7a0be131c9a6f5`
  - `google/gemini-3.1-flash-tts`
  - `minimax/speech-2.8-turbo`
  - `qwen/qwen3-tts`
  - `inworld/tts-1.5-mini`
- You can also choose `Other` and enter any Replicate model ID (for example `owner/model-name` or `owner/model-name:version`).
- Native model speed is not available on all Replicate models; OpenReader hides/disables native speed controls where unsupported.
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [Replicate](https://replicate.com/explore)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
