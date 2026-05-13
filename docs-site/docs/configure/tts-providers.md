---
title: TTS Providers
---

OpenReader routes all TTS requests through the Next.js server to an OpenAI-compatible API. There are three places provider configuration can live:

**Admin-managed shared providers** (Settings > Admin > Shared providers): DB-backed instances configured by an admin and visible to all users. Keys are encrypted at rest and never exposed to the client. Available only when [auth is enabled](./auth) and your account is in `ADMIN_EMAILS`. See [Admin Panel](./admin-panel).

**Per-user Settings modal** (Settings > TTS Provider): provider + API key stored in the user's browser and sent with every TTS request. This path is available only when the admin/runtime setting `restrictUserApiKeys=false`.

**Environment variables**: `API_KEY` and `API_BASE` exist as a one-shot first-boot seed that auto-creates a `default-openai` admin shared provider. After the first boot they are no longer read by the running app.

:::tip
If you're running a private/self-hosted instance and want per-user BYOK behavior, turn off **Settings → Admin → Site features → Restrict user API keys**. Legacy first-boot seed via `NEXT_PUBLIC_RESTRICT_USER_API_KEYS=false` is still supported for no-admin bootstrap flows.
:::

## Providers

- **OpenAI**: Cloud. Base URL pre-filled (`https://api.openai.com/v1`). API key required.
- **Replicate**: Cloud. Base URL managed internally by OpenReader. API key required.
- **DeepInfra**: Cloud. Base URL pre-filled (`https://api.deepinfra.com/v1/openai`). API key required.
- **Custom OpenAI-Like**: Self-hosted or any custom endpoint. `API_BASE` must be set manually (typically ending in `/v1`). API key optional.

For `OpenAI`, `DeepInfra`, and `Replicate` you only need to supply an API key. For `Custom OpenAI-Like` you must also set `API_BASE`.

## Built-in model catalogs

- **Replicate** models: `alphanumericuser/kokoro-82m`, `google/gemini-3.1-flash-tts`, `minimax/speech-2.8-turbo`, `qwen/qwen3-tts`, `inworld/tts-1.5-mini` (or choose `Other` and enter any Replicate model ID, such as `owner/model` or `owner/model:version`)
- **OpenAI** models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`
- **DeepInfra** models: includes `hexgrad/Kokoro-82M` and additional hosted models (depending on API key / feature flags)

## Custom provider requirements

Self-hosted or custom providers must expose OpenAI-compatible audio endpoints:

- `GET /v1/audio/voices`
- `POST /v1/audio/speech`

:::warning TTS requests are server-side
TTS requests originate from the **Next.js server**, not the browser. `API_BASE` must be reachable from the server runtime. In Docker, use container names or `host.docker.internal` rather than `localhost`.
:::

## Provider guides

- [Kokoro-FastAPI](./tts-provider-guides/kokoro-fastapi)
- [KittenTTS-FastAPI](./tts-provider-guides/kitten-tts-fastapi)
- [Orpheus-FastAPI](./tts-provider-guides/orpheus-fastapi)
- [Replicate](./tts-provider-guides/replicate)
- [DeepInfra](./tts-provider-guides/deepinfra)
- [OpenAI](./tts-provider-guides/openai)
- [Other](./tts-provider-guides/other)

## Related

- [Admin Panel](./admin-panel) — DB-backed shared providers with encrypted keys
- [TTS Environment Variables](../reference/environment-variables#tts-provider-and-request-behavior)
- [TTS Rate Limiting](./tts-rate-limiting)
