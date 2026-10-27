---
title: OpenRouter
---

Use speech models from many companies through one
[OpenRouter](https://openrouter.ai/settings/keys) API key.

1. Open **Settings → Admin → Providers → Add provider**.
2. Choose **OpenRouter** and enter your API key.
3. Choose a model. The list is OpenRouter's current speech catalog, including
   free variants. New setups use **Fish Audio: S2.1 Pro Free** (`fish-audio/s2.1-pro-free:free`).
   Choose **Other** to enter a model ID that is not listed.
4. Save, then use **Check** to verify the key and generate a short worker sample.
5. In **Model & Voice**, choose the provider and a voice.

Model IDs are used exactly as OpenRouter lists them, including suffixes such as
`:free`. When a model leaves the catalog, saved choices and cached audio stay
as they are.

## Voices

Each model's voices come from OpenRouter's catalog. Fish Audio models, which
the catalog lists without voices, offer the same voices as the native
[Fish Audio](./fish-audio) provider. Some models also offer **default**, which
lets the model choose. **Custom voice ID** accepts any other voice the model
supports.

On models whose endpoints support voice cloning, users can
[create their own voice](../../guide/reading-and-listening#your-own-voice).
The transcript is optional. The sample is sent inline with each narration
request.

## Instructions, speed and model options

**Instructions** appears only for models known to accept it: OpenAI
`gpt-4o-mini-tts`, Google Gemini TTS and Fish Audio models. It is sent in
OpenRouter's `instructions` field. Native speed is offered for OpenAI, Fish
Audio and ByteDance Seed Audio models. Audio player speed works with every model.

**Model options** sets JSON sent with every request for the selected model. It
accepts `provider.options` keyed by provider, the `zdr` and `data_collection`
data policy, and public HTTPS `input_references`, up to 16 KB. It never accepts
credentials. The admin value is the default; users can override it under
**Advanced model options** in **Model & Voice**, or choose **Use provider default**.
Changing the model restores that model's default rather than carrying options
across. See OpenRouter's
[speech guide](https://openrouter.ai/docs/guides/overview/multimodal/tts#provider-specific-options)
for each provider's options.

The key stays encrypted in OpenReader and reaches only OpenRouter's fixed
endpoint through the credential broker. No additional environment variable is
needed.
