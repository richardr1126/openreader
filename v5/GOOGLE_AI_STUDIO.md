# Google AI Studio replacement

Reader parity item 10 replaces the DeepInfra integration on web/desktop and
Swift with native Google AI Studio speech. The provider ID is `google-ai-studio`
on web and `googleAIStudio` on Swift. Default model/voice:
`gemini-3.8-flash-tts` / `Zephyr`; the alternative is
`gemini-3.8-flash-lite-tts`. Both expose the existing 30 Gemini presets and
custom voice IDs, Instructions, and no numeric native speed.

Use `POST https://generativelanguage.googleapis.com/v1beta/interactions` with
`x-goog-api-key`. Transcript text lives in the text content; Instructions live
in `speech_metadata.style`. Request WAV, 24 kHz, and `store: false`. REST audio
is the final audio content in `steps` of type `model_output`; `output_audio`
is only an SDK convenience property. Require completed status and valid WAV.
Bound JSON/base64 and decoded audio, split long input at the provider boundary,
refuse redirects, and preserve existing abortable retries/deadlines.

Web uses the existing encrypted app-owned credential and worker broker.
Swift uses existing Keychain, device permission and bounded direct transport.
No credentials in jobs, settings responses, logs or artifacts. Existing
normalization, alignment, pauses, durable cache and export retain their owners.
Model, voice and effective Instructions use the existing audio identity.

Remove the old catalog, requests, voice fetches, branding and active guide.
Keep archived documentation for released versions. SQL migration 0025 removes
DeepInfra rows and any installation default pointing to them, matching the
Speech SDK removal. No new schema field, dependency or environment variable.
Native cleanup removes retired setups without losing unrelated providers,
clears their Keychain/consent entries and advances the existing preference sync
clock so cleanup propagates through the normal CloudKit record.
Never convert an old key/model/voice to Google. Cached document audio remains.
Production migrations are still owner-coordinated; no production action is
part of implementation.

On 2026-10-26 the supplied test key listed both 3.8 models and a direct Flash
request returned a completed 150,116-byte WAV with Zephyr and style metadata.
The test key is held only for transient requests and is not saved in either
repository. The TypeScript adapter also completed a live Flash/Zephyr request
and normalized it to a 45 KB MP3 through the real audio pipeline. Google
generation inside an actual reader and live native Google synthesis were not
separately exercised; native response-to-audio conversion uses fixture tests.

Web validation passes all 1,522 unit tests and all 71 Chromium/WebKit cases,
including Google setup/save/reload and both consolidated real playback journeys.
Production and documentation builds, app/worker type checks and route/compute/
install-profile boundaries pass. Visible web checks confirm Flash-Lite, Kore,
Instructions persistence and hidden numeric generation speed. Port 3003 is free
after teardown. The first sandboxed browser attempt could not register its
macOS Mach port; the complete run passed with the required host permissions.

The native simulator build and full suite pass: eight navigation tests and
451 package Swift Testing cases. Two unrelated system-speech timing assertions
failed initially, then passed in isolation and in the complete rerun. Native
Google setup, models, Instructions, voices and the expanded custom voice field
were inspected without saving a key or changing the saved reading voice.
Catalyst Release compiled before the final small voice-validation/sync-clock
changes; the simulator build covers those final changes and the focused
configuration suite passes all 12 cases. The complete native suite passed again
after those final cleanup changes. No SQL migration has been applied to the owner's normal data or
production; the SQLite removal migration was exercised in a disposable database.

Source: [Google speech generation](https://ai.google.dev/gemini-api/docs/speech-generation).
