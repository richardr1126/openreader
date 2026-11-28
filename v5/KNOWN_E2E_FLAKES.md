# Known E2E Flakes

Open intermittent Playwright failures that reproduce on `main`. Each is a
product bug to root-cause, not a test to retry or loosen (CI runs with
`failOnFlakyTests`). Remove an entry once its fix lands.

## WebKit playback journey

- **Test:** `tests/e2e/playback-controls.spec.ts:354`, "anonymous user controls
  playback across every accepted document journey", project `playback-webkit`
  (local only; true playback does not run in CI).
- **First logged:** 2026-11-28, while validating #249.
- **Reproduces on `main`:** at `5bd68c96`, 3 of 4 runs failed with
  `pnpm test:e2e --project=playback-webkit --repeat-each=4`. On #249's branch,
  6 of 15 runs failed with the same modes, so #249 did not introduce it.
- **Failure modes:**
  1. `verifyEpubPlayback`, line 337: after "Return to narration" the EPUB word
     highlight stays empty for 15 seconds.
  2. `verifyWordOnlyPlayback`, line 113: after Play on the PDF, Pause never
     appears within 60 seconds. The trace shows the session created, two
     `/timeline?minOrdinal=0` reads, then only `/cursor` heartbeats every four
     seconds and no audio request.
  3. Seen once: line 461, the pending voice changes never show
     `Speed 1x → 1.1x`.
- **Diagnosing:** add `stdout: 'pipe'` to `webServer` in `playwright.config.ts`
  temporarily to see worker logs, and revert it afterwards. Do not set
  `DEBUG=pw:webserver`: `weed mini` parses `DEBUG` and exits. Traces land in
  `tests/results/<test>/trace.zip`, with requests in `0-trace.network`.
- **Status:** open.
