# Fish Audio

Reader parity item 8 adds Fish Audio to the web and Swift external-provider
catalogs. Both call `POST https://api.fish.audio/v1/tts`, using bearer auth and
an explicit `model` header. New setups select `s2.1-pro-free`. S2.1 Pro, S2 Pro,
S1 and Drama 3 are explicit alternatives; unsupported IDs fail locally because
Fish's API otherwise falls back to a paid model. A failed free request never
substitutes a paid model.

The `default` voice omits `reference_id`. A custom voice ID sends the selected
Fish voice model reference instead, for consistent narration across requests.
This increment does not import Fish's public voice library or upload recordings.
Native speed uses `prosody.speed` within 0.5–2.0. The existing Swift UI's narrower
app-wide speed range remains in effect. Model, reference and speed participate
in the existing audio identity; choosing a different voice preserves old audio.

## Execution and credentials

On web, credentials remain encrypted with the existing app-owned key. The
worker obtains them from the authenticated credential broker and executes the
Fish request. Jobs, browser settings and events contain no key. The provider
ignores custom endpoint overrides and refuses redirects. Provider checks use
Fish's voice metadata endpoint; a saved provider's sample runs through the
worker. Metadata access does not prove generation credit or model entitlement.

On Swift, the existing Keychain, sync preference and per-device consent rules
apply. The app calls Fish directly using the ephemeral bounded transport;
no web server or broker is involved. Both platforms request MP3 and retain
the existing audio normalization, alignment, playback, pause/seek cancellation,
cache and export paths. Fish responses are bounded to 32 MiB per request.
Retries preserve the selected model, respect Retry-After, and stop on
cancellation/deadline. Errors expose HTTP status, never the upstream body.
No new schema, migration, dependency or environment configuration is required.

## Verification

On 2026-10-25, the supplied test account returned MP3 successfully with
`s2.1-pro-free`. The TypeScript adapter also generated and normalized a real
sample. These checks establish current free-model access only; paid models and
custom reference IDs are covered by request-contract tests rather than billed
live calls. Native synthesis uses the shared audio-path fixture tests.

The web production build, application/worker type checks and boundary checks
pass. The full unit suite passes 1,477 tests. The iOS build and full native
suite pass, including the reader-navigation regressions already in the checkout.
The Mac Catalyst Release target also compiles; its UI was not exercised.
Manual checks covered web model selection and custom-reference persistence,
plus the iPhone 18 Pro add-provider/editor/sample-reference controls. Native
setup drafts were dismissed without saving a credential or changing the saved
reading voice. Native live Fish playback and paid-model execution were not
exercised.

API contract: [Fish Audio speech reference](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech).
