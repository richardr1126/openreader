---
title: Custom OpenAI
---

Use any custom OpenAI-compatible TTS service with OpenReader.

Use this integration when your endpoint is not directly covered by built-in dropdown defaults.

## Provider

- Provider: `Custom OpenAI-Like`
- `API_BASE`: required (your service base URL)
- `API_KEY`: set if required by your service

Custom providers should expose:

- `GET /v1/audio/voices`
- `POST /v1/audio/speech`

## OpenReader setup

1. In OpenReader Settings, choose provider `Custom OpenAI-Like`.
2. Set `API_BASE` to your service base URL (typically ending with `/v1`).
3. Set `API_KEY` if your service requires authentication.
4. Choose a model and voice supported by your backend.

## Notes

:::warning Compatibility required
Custom providers must implement OpenAI-compatible TTS endpoints, including `GET /v1/audio/voices` and `POST /v1/audio/speech`.
:::

:::info Voice troubleshooting
If voices do not load, verify the `/v1/audio/voices` response shape and that the endpoint is reachable from the OpenReader server.
:::

## References

- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
