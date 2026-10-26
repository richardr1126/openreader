---
title: Google AI Studio
---

Use Google's Gemini speech API directly with an API key from
[Google AI Studio](https://aistudio.google.com/api-keys).

1. Open **Settings → Admin → Providers → Add provider**.
2. Choose **Google AI Studio** and enter your Google API key.
3. Choose **Gemini 3.8 Flash TTS** (the default) or **Gemini 3.8 Flash-Lite TTS**.
4. Save, then use **Check** to verify access and generate a short worker sample.
5. In **Model & Voice**, choose the provider and a voice. New setups use **Zephyr**.

Both models offer 30 prebuilt voices. **Custom voice ID** accepts additional
library or custom voice IDs supplied by Google. Create/manage those voices in
AI Studio; OpenReader does not upload recordings or create voices.

**Voice instructions** controls delivery, such as `Calm, warm narration`.
Instructions are sent separately from the passage using Google's speech
metadata. Numeric generation speed is unavailable; audio player speed still
works with generated audio.

The worker sends bounded text pieces to Google's Interactions API and converts
the returned WAV audio for the existing playback, alignment, cache and export
paths. The key remains encrypted in OpenReader and reaches only Google's fixed
endpoint through the credential broker. No additional environment variable is
needed. Request failures never switch to a different model.

The generic `gemini-flash-latest` text model is not a speech model. Google AI
Studio keys also differ from Google Cloud Text-to-Speech service credentials.

## Replacing the removed provider

DeepInfra is no longer offered. The upgrade removes its saved provider entries,
encrypted keys and any installation default pointing at one, following the
earlier Speech SDK removal. Choose a remaining provider or add Google AI Studio
with a new Google key. Stored document audio is not deleted or relabeled.

API contract: [Google speech generation](https://ai.google.dev/gemini-api/docs/speech-generation).
