---
title: Fish Audio
---

Use Fish Audio's speech API directly with an API key from
[Fish Audio](https://fish.audio/app/api-keys).

1. Open **Settings → Admin → Providers → Add provider**.
2. Choose **Fish Audio** and enter your API key.
3. Choose a model. New setups use **S2.1 Pro Free** (`s2.1-pro-free`); **S2.1 Pro**, **S2 Pro** and **Drama 3** are paid.
4. Save, then use **Check** to verify access and generate a short worker sample.
5. In **Model & Voice**, choose the provider and a voice. New setups use **Sarah**.

Whether the free model is available depends on your account and Fish's
current service. OpenReader never retries a failed free-model request with a
paid model.

## Voices

All four models offer **Sarah**, **Energetic Male**, **Adrian**, **Delia** and
**Sheila**. These fixed voice references keep narration consistent across
passages. Enter any other Fish voice model ID under **Custom voice ID**.

The **default** option, at the bottom of the list, lets Fish choose a voice for
each request. Existing setups that saved **default** keep it until a named
voice is chosen and saved (or applied in the reader).

Users can also [create their own voice](../../guide/reading-and-listening#your-own-voice)
from a short recording. Fish needs the exact words spoken in the sample, so
the transcript is required. The sample is sent with each narration request;
creating a voice does not use Fish's model-creation allowance.

## Instructions and speed

**Voice instructions** accepts a short direction such as `Warm, calm narration`.
OpenReader adds it as a bracketed cue to each request after text filtering,
without changing the displayed passage or the word timing. Changing the
direction generates a separate, reusable version of the audio.

Native generation speed supports 0.5×–2×. Audio uses the usual worker alignment,
playback cache and export paths.

## Checking the provider

**Check** verifies API access with Fish's voice metadata endpoint. After saving,
it also generates a short sample through the worker, since metadata access
alone does not prove generation credit or model access.

API contract: [Fish Audio text to speech](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech).
To use Fish models through OpenRouter's billing instead, see [OpenRouter](./openrouter).
