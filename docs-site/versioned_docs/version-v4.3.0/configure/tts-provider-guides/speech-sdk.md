---
title: Speech SDK
---

Use [speech-sdk](https://github.com/Jellypod-Inc/speech-sdk) (Apache 2.0) to reach additional cloud TTS providers (ElevenLabs, Cartesia, Hume, Deepgram, Google Gemini TTS, Inworld, and more) with your own provider API keys. Requests go from the OpenReader server directly to the provider's API; no extra account or proxy is involved.

Models use the `provider/model` format. The API key you enter belongs to the provider named by the model prefix: for `elevenlabs/eleven_multilingual_v2` enter an ElevenLabs key, for `cartesia/sonic-3.5` a Cartesia key, and so on.

## Setup

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `speech-sdk`.
2. Enter the API key for the provider you want to use.
3. Set default model to a matching `provider/model` (for example `elevenlabs/eleven_multilingual_v2`).

**Per-user Settings → TTS Provider (only when `restrictUserApiKeys=false`):**

1. Set provider to `Speech SDK`.
2. Choose a model; enter the API key for that model's provider.
3. Choose a voice.

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

## Built-in models

- `openai/gpt-4o-mini-tts` (works with your existing OpenAI API key)
- `elevenlabs/eleven_multilingual_v2`
- `cartesia/sonic-3.5`
- `deepgram/aura-2`
- `google/gemini-2.5-flash-preview-tts`
- `inworld/inworld-tts-1.5-max`

You can also choose `Other` and enter any `provider/model` the SDK supports. Recognized prefixes: `openai`, `elevenlabs`, `cartesia`, `hume`, `deepgram`, `google`, `inworld`, `minimax`, `fish-audio`, `murf`, `resemble`, `fal-ai`, `mistral`, `xai`, `smallest-ai`.

## Voice IDs

ElevenLabs and Cartesia identify voices by opaque IDs. The built-in lists map to these shared library voices:

| ElevenLabs ID | Name | | Cartesia ID | Name |
| --- | --- | --- | --- | --- |
| `JBFqnCBsd6RMkjVDRZzb` | George | | `a0e99841-438c-4a64-b679-ae501e7d6091` | Barbershop Man |
| `IKne3meq5aSn9XLyUdCD` | Charlie | | `156fb8d2-335b-4950-9cb3-a2d33f0c0c2a` | British Lady |
| `XB0fDUnXU5powFXDhCwa` | Charlotte | | `694f9389-aac1-45b6-b726-9d9369183238` | California Girl |
| `Xb7hH8MSUJpSbSDYk0k2` | Alice | | `87748186-23bb-4571-8b8b-a73da9bf9c4f` | Commercial Lady |
| `iP95p4xoKVk53GoZ742B` | Chris | | `ee7ea9f8-c0c1-498c-9f62-dc2da49a6f98` | Friendly Reading Man |
| `nPczCjzI2devNBz1zQrb` | Brian | | `248be419-c632-4f23-adf1-5324ed7dbf1d` | Hannah |
| `onwK4e9ZLuTAKqWW03F9` | Daniel | | | |
| `pFZP5JQG7iQjIQuC4Bku` | Lily | | | |
| `pqHfZKP75CvOlQylNhV4` | Bill | | | |

## Notes

- One voice per request; Kokoro-style multi-voice mixing does not apply to this provider.
- Playback speed is applied client-side, so cached audio segments stay valid when you change speed.
- Providers without a built-in voice list fall back to a `default` entry, which lets the provider pick its default voice.
- Word-by-word highlighting works the same as with every other provider (alignment runs in OpenReader, not the provider).
- TTS requests are sent from the server, not the browser. The API key is never exposed to clients.

## References

- [speech-sdk on GitHub](https://github.com/Jellypod-Inc/speech-sdk)
- [TTS Providers](../tts-providers)
