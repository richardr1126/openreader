# Fish Audio

Reader parity item 8 adds Fish Audio to the web and Swift external-provider
catalogs. Both call `POST https://api.fish.audio/v1/tts`, using bearer auth and
an explicit `model` header. New setups select `s2.1-pro-free`. S2.1 Pro, S2 Pro,
and Drama 3 are explicit alternatives; unsupported IDs fail locally because
Fish's API otherwise falls back to a paid model. A failed free request never
substitutes a paid model.

All four models offer five curated public references: Sarah (the new default),
Energetic Male, Adrian, Delia and Sheila. Names are presentation only; persisted
selections, preview requests, synthesis and cache keys use the reference ID.
Custom voice IDs remain available. Existing saved `default` selections still
omit `reference_id`; selecting a named voice and saving/applying opts into a
fixed reference without rewriting cached audio. Recording uploads and browsing
the entire public library remain outside this integration.
Native speed uses `prosody.speed` within 0.5–2.0. The existing Swift UI's narrower
app-wide speed range remains in effect. Model, reference and speed participate
in the existing audio identity; choosing a different voice preserves old audio.

## Execution and credentials

S2/S2.1 and Drama 3 expose the existing Instructions field. Each outbound piece
gets a square-bracket direction prefix after speech-text filtering. Brackets
and whitespace in the direction are normalized into a single cue. The original
passage remains the source for rendering and alignment, and existing instruction
cache components distinguish directed audio. Empty directions retain unchanged
audio identity. Retired S1 selections fail locally without changing saved audio
identity or substituting a paid model.

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

The 2026-10-26 directions/S1-removal follow-up passes all 1,480 web unit tests,
the production build, application/worker type checks, boundary checks, and the
iOS build and full native suite. Both Fish browser cases pass, including
instructions persistence and S1 absence. The complete browser matrix reports
64 passes, one failure in the existing reader-defaults reset case (Show the
pages stays checked after Use app default), and two dependent playback cases
not run. No reader-default behavior was changed in this follow-up. The web
instructions save/reload and native style-instructions control were inspected
directly; native provider setup was dismissed without changing saved settings.

The named-voice follow-up verifies all five references as public, trained English
voices through Fish's model metadata endpoint. Sarah also returned MP3 with the
free model. Paid-model generation was not exercised. The curated references
come from Fish's [developer examples](https://fish.audio/developers/) and
[Drama 3 guide](https://docs.fish.audio/features/text-to-speech/drama-3).
All 1,481 web unit tests, the web production build, app/worker type and boundary
checks, the iOS build and full native suite pass. Manual checks confirm web
named-voice save/reload and native named-voice draft selection; the native draft
was dismissed without changing the saved reading voice.
The complete Chromium/WebKit matrix passes all 67 cases, including both Fish
cases across all four models and the consolidated real playback journeys.
Port 3003 is free after teardown.
The automatic `default` option remains permanently at the bottom of each Fish
model's voice list, including after a named voice has been selected.
