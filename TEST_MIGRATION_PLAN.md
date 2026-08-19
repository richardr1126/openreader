# Playwright Clean-Slate Replacement Plan

## Decision

The existing Playwright tests will not be migrated, repaired, or used as the
foundation of the replacement suite. Their specs, shared helpers, teardown,
fixtures, reports, and Playwright-only application scaffolding will be removed.
The Playwright dependency, cross-browser configuration, package script, report
ignores, README badge, and CI workflow stay in place for the replacement suite.

The reset has an intentional intermediate state: **the repository contains only
Vitest test cases and no Playwright specs or helpers**. The empty Playwright
harness remains ready for the new browser suite, which is introduced one
observed user journey at a time.

The old Playwright files may be used once to inventory the behavior they were
trying to cover. Their selectors, helper implementations, waits, request-level
assertions, and test structure must not be copied into the new suite.

## Goals

1. Remove all existing Playwright specs, helpers, teardown, fixtures, and
   test-only application paths before creating replacement browser tests.
2. Preserve meaningful unit and integration coverage in Vitest.
3. Observe every replacement journey with computer use against the running
   application before writing its test.
4. Make each new Playwright test reproduce the observed user actions through
   the visible interface.
5. Assert outcomes a user can see or perceive: content, controls, routes,
   dialogs, focus, progress, and actionable errors.
6. Build a small suite of independent journeys rather than recreating the old
   suite test-for-test.
7. Add shared support only after repeated new tests prove that an abstraction
   is necessary.
8. Run every replacement journey in Chromium, Firefox, and WebKit concurrently
   with the worker pool capped at 50% of the machine's logical CPUs.
9. Prove that independent users and browser sessions can use the application at
   the same time without test data, authentication, or storage collisions.

## Non-Goals

- Do not make the old Playwright suite green before deleting it.
- Do not run the old suite as a baseline.
- Do not preserve an old test merely because it exists.
- Do not copy `tests/helpers.ts` into smaller files.
- Do not use the old suite as the source of selectors or timing behavior.
- Do not recreate backend protocol, hashing, storage, retry, or lifecycle tests
  in a browser when Vitest can own them deterministically.
- Do not write a replacement test before completing its computer-use
  walkthrough.
- Do not serialize browser projects or test files to hide shared-state defects.
- Do not reduce the browser matrix because one engine exposes a product defect.

---

## Mandatory Creation Rule

Every new browser test follows this sequence without exception:

```text
Choose one replacement journey
        ↓
Start the current application with controlled test data
        ↓
Use computer use to perform the journey through the visible UI
        ↓
Record the actual controls, labels, route changes, visible states, and errors
        ↓
Decide which assertions belong in Playwright and which belong in Vitest
        ↓
Create one small Playwright test from the observed journey
        ↓
Run that exact test in Chromium, Firefox, and WebKit concurrently
        ↓
Inspect the page, trace, screenshot, console, and requests if it fails
        ↓
Correct the product or the test at the boundary that is actually wrong
        ↓
Accept the test only when it independently passes
```

Computer use is the discovery step. Playwright is the repeatable automation
step. A test is not allowed to be designed from source inspection alone.

### Computer-use walkthrough record

Before creating a test, record:

- the journey name and user-visible purpose;
- the initial data and authentication state;
- every visible control used, preferably by accessible role and name;
- the route changes and important intermediate states;
- the final user-visible success condition;
- any visible failure or recovery state;
- screenshots for states that are difficult to describe;
- behavior that was considered but assigned to Vitest instead.

The walkthrough must use the same kind of interaction a user performs. Click
buttons and links, type into fields, select options, use keyboard navigation,
upload through the file input, and use real drag gestures where drag-and-drop is
the contract. Direct API calls or `page.evaluate(fetch(...))` are not substitutes
for a user journey.

### Rules for new tests

- Prefer accessible roles, names, labels, and visible text observed during the
  walkthrough.
- Use a test id only when the state has no suitable accessible representation.
- Do not use CSS implementation details as readiness signals.
- Do not use arbitrary sleeps as proof that an operation completed.
- Keep action and assertion code local to the first test that needs it.
- Extract a helper only after at least two accepted tests repeat the same action
  with the same contract.
- A helper performs one action or observes one state; it does not hide an entire
  journey.
- Each test owns its data and can run by itself.
- Each test uses a unique user/session and unique data identifiers so the same
  journey can run in all browser projects at once.
- Tests and projects remain fully parallel unless a scenario is inherently
  serial and that product constraint is explicitly documented.
- Test titles describe what the user can accomplish, not internal machinery.
- A timeout must report the last visible application state.

---

## Phase 0: Record the Replacement Inventory

Status: complete.

Use the old spec titles only to create the inventory below. Do not execute the
old suite and do not diagnose or repair its failures.

Gate:

- every old browser scenario is represented in the inventory;
- each scenario is marked Replace, Vitest, Merge, or Drop;
- no old helper or selector has been adopted by the new design.

## Phase 1: Remove the Existing Playwright Suite

Status: complete.

Delete the existing browser test implementation:

- `tests/accessibility.spec.ts`;
- `tests/delete.spec.ts`;
- `tests/folders.spec.ts`;
- `tests/landing-routing.spec.ts`;
- `tests/navigation.spec.ts`;
- `tests/play.spec.ts`;
- `tests/upload.spec.ts`;
- `tests/helpers.ts`;
- `tests/global-teardown.ts`;
- `tests/support/s3-prefix-cleanup.ts` if it has no non-Playwright owner;
- generated Playwright result and report directories;
- the old `test` script that currently invokes Playwright.

Retain and clean up the empty replacement harness:

- keep `playwright.config.ts` with Chromium, Firefox, and WebKit;
- keep `fullyParallel: true` and `workers: '50%'`;
- keep the direct `@playwright/test` development dependency;
- keep `pnpm test:e2e` for the replacement browser suite;
- keep `.github/workflows/playwright.yml`, the README badge, and report ignores;
- remove namespace headers and teardown references from the retained harness;
- allow the CI job to pass with no tests during the intentional reset
  checkpoint.

Make `pnpm test` run the retained Vitest suite. Regenerate the lockfile through
the package manager rather than editing it by hand.

Remove the `x-openreader-test-namespace` request header,
`ENABLE_TEST_NAMESPACE`, their route wiring, the namespace-specific account
cleanup pass, and the namespace-triggered mock TTS response. The rebuilt suite
will rely on real user/session ownership and canonical storage concurrency.

This phase does not remove the generic nullable `namespace` field from the
compute-worker and storage protocols. That is a separate cross-service schema
and artifact-layout decision, not required to remove the old Playwright suite.
Normal application requests no longer have a path that supplies a test
namespace.

Audit `tests/files/` by reference. Keep fixtures used by Vitest or compute-worker
tests. Delete Playwright-only fixtures at the reset boundary; add a fixture back
later only when an observed replacement journey needs it.

Gate:

- no old Playwright spec, helper, fixture, teardown, or namespace wiring
  remains;
- `pnpm test` invokes Vitest and `pnpm test:e2e` invokes Playwright;
- the retained config defines Chromium, Firefox, and WebKit with full
  parallelism and a 50% worker cap;
- the `tests/` tree contains only Vitest tests, their support, and fixtures they
  actually reference;
- `pnpm test` (or the documented Vitest command) passes;
- the empty Playwright harness exits successfully with `--pass-with-no-tests`;
- type checking and the relevant build checks pass;
- no replacement browser spec exists yet.

This clean checkpoint must be completed and reviewed before the first
replacement Playwright spec is added.

### Phase 1 acceptance evidence

- Pre-existing reader/playback work was isolated first in commit `89293420`.
- `pnpm test` runs Vitest: 110 files and 553 tests passed.
- `pnpm exec playwright test --pass-with-no-tests` passed with the retained
  empty three-browser harness.
- `pnpm exec tsc --noEmit` passed.
- `pnpm build` passed.
- `pnpm build:bundle-guard` passed.
- `pnpm check:compute-boundary` passed.
- `pnpm docs:build` passed.
- The old browser specs, helpers, teardown, Playwright-only fixtures,
  request-namespace entry point, and namespace-triggered TTS mock are removed.
- The Playwright dependency, configuration, `test:e2e` script, CI workflow,
  README badge, and artifact ignores remain for the replacement suite.

---

## Replacement Inventory

The decisions below describe coverage intent, not a promise to preserve the old
number of tests.

| Existing coverage | Decision | Replacement owner |
|---|---|---|
| Upload PDF, EPUB, and TXT individually | Merge | One computer-observed supported-upload library journey, with format-specific reader journeys below |
| Reuse canonical ID for identical uploads | Vitest | Document/storage integration test; no browser API inspection |
| UTF-8 stored-content hashing | Vitest | Blob/document integration test |
| DOCX upload and conversion | Replace + Vitest | Vitest owns conversion lifecycle; one browser smoke journey observes upload, converted PDF appearance, and open |
| Display PDF | Replace | Observed PDF open/readiness journey |
| Display EPUB | Replace | Observed EPUB open/readiness journey |
| Display TXT | Replace | Observed text open/readiness journey |
| Display DOCX as converted PDF | Merge | Covered by the DOCX smoke journey |
| Upload several formats and open each | Drop as a combined test | Covered by independent upload and reader journeys without a long cascade |
| Markdown rendering and TXT formatting | Replace + Vitest | Browser checks meaningful rendered differences; detailed transformation rules stay in Vitest |
| Unsupported file is ignored | Replace | Observed rejection journey asserting the actual visible response; add product feedback if none exists |
| Play and pause PDF, EPUB, DOCX, and TXT separately | Merge | One primary playback journey plus only format-specific smoke cases shown necessary by walkthroughs |
| Change single voice and resume | Replace | Observed settings/playback journey |
| Preserve selected voice | Vitest + optional browser smoke | State persistence belongs in Vitest; browser test only if the walkthrough exposes a critical user regression |
| Select multiple Kokoro voices | Replace only when runnable | Observed provider-specific journey in an explicitly configured environment |
| Change native speed and resume | Replace | Observed speed/playback journey |
| Route to PDF, EPUB, and HTML viewers | Merge | Covered by independent reader journeys and their visible URLs |
| Restore PDF highlight after viewport narrowing | Replace | Observed responsive PDF/highlight journey |
| PDF Single, Dual, Scroll, and Navigator behavior | Replace | Observed PDF navigation journey; split only if independent failures require it |
| EPUB resize pauses playback | Replace | Observed responsive EPUB/playback journey |
| Public landing without anonymous bootstrap request | Vitest + Replace | Request policy belongs in Vitest; browser journey verifies the public landing visibly renders |
| Authenticated `/` redirects to `/app` | Replace | Observed authenticated routing journey |
| Reader back link returns to `/app` | Replace | Fold into one reader journey if it remains a visible navigation contract |
| Protected routes redirect anonymous users | Replace + Vitest | Browser verifies visible redirect/sign-in result; route policy remains in Vitest |
| Accessible upload control and hint | Replace | Fold into keyboard/accessibility smoke journey |
| Accessible document links | Replace | Fold into library accessibility smoke journey |
| Delete confirmation dialog semantics | Merge | Covered by observed delete journey with keyboard and focus assertions |
| TTS labels and keyboard focus | Merge | Covered by observed playback accessibility journey |
| Folder creation by drag-and-drop and persistence | Replace | Observed pointer drag, reload, and visible persistence journey |
| Dismiss folder hint and persist | Merge | Accepted in `folder-persistence.spec.ts`: dismiss the visible hint before dragging, then require it to remain absent after the journey's existing reload |
| Delete a document and update the list | Replace | Observed confirmation and library-update journey |

### Proposed new browser journeys

The walkthroughs may merge or remove these, but no journey may be added without
observing it first.

1. Public landing and anonymous app-entry/onboarding until the library is
   interactable. Accepted in Phase 2.
2. Upload supported documents and observe them in the library.
3. Reject an unsupported upload with useful visible feedback.
4. Open and visibly read a PDF.
5. Open and visibly read an EPUB.
6. Open TXT and Markdown and observe their meaningful rendering difference.
7. Upload DOCX, observe conversion to PDF, and open it.
8. Navigate PDF view modes and pages.
9. Create a folder with drag-and-drop and verify persistence after reload.
10. Delete a document through the confirmation dialog.
11. Start and pause playback, including visible state and keyboard access.
12. Change voice and speed, then resume playback.
13. Verify responsive behavior that materially changes PDF interaction.
14. Verify responsive behavior that materially changes EPUB interaction.
15. Verify authenticated routing when a controlled authenticated state is
    available.

### Core replacement suite

The core suite is intentionally smaller than the complete replacement
inventory. It proves that a new user can enter the product, add supported
content, read the principal document types, recover from invalid input, manage
the library, and use the primary playback control. Each item still requires its
own computer-use walkthrough before implementation.

| Priority | User-visible contract | Browser owner | Deterministic owner outside Playwright |
|---:|---|---|---|
| 1 | Anonymous first-run entry reaches a usable library | Accepted `anonymous-entry.spec.ts` | Consent persistence, onboarding ordering, and anonymous-session policy remain in Vitest |
| 2 | PDF, EPUB, and TXT uploads appear in the library | Accepted `supported-upload.spec.ts`: one multi-file upload journey using the visible file chooser | Presigning, hashing, canonical IDs, storage writes, and per-format validation remain in Vitest |
| 3 | Unsupported input produces useful visible feedback and no library item | Accepted `unsupported-upload.spec.ts`: one visible rejection journey with an unchanged empty library | MIME/extension policy and route error mappings remain in Vitest |
| 4 | A PDF opens, reaches a visible ready state, and exposes readable page content | Accepted `pdf-reader.spec.ts`: upload, open, readable content and controls, then return to the library | Parsing, layout artifacts, bootstrap events, and storage leases remain in Vitest |
| 5 | An EPUB opens, reaches a visible ready state, and exposes readable chapter content | Accepted `epub-reader.spec.ts`: upload, open, reader controls, and actual rendered book content | Spine coordinates, placement, locations, and bootstrap state remain in Vitest |
| 6 | TXT and Markdown open with a meaningful visible rendering difference | Accepted `text-markdown-reader.spec.ts`: one literal-text and semantic-Markdown comparison journey | Text decoding, Markdown transformation, and HTML block rules remain in Vitest |
| 7 | DOCX visibly converts to PDF and the result opens | Accepted `docx-conversion.spec.ts`: source progress, converted PDF arrival, and readable result | Conversion lifecycle, event completion, finalization, and cleanup remain in Vitest |
| 8 | A user confirms deletion and the document disappears from the library | Accepted `document-deletion.spec.ts`: cancel by keyboard, confirm visibly, and observe the empty library | Blob cleanup, leases, and account ownership remain in Vitest |
| 9 | A user starts and pauses reading in every accepted document journey | Accepted `playback-controls.spec.ts`: the single synthesis-dependent journey per browser covers keyboard control for TXT, Markdown, EPUB, PDF, and converted DOCX | Provider protocol, segment planning, audio alignment, caching, token contracts, and detailed progress remain in Vitest or a separate focused journey |
| 10 | A user navigates PDF pages and changes the visible page mode | Accepted `pdf-navigation.spec.ts`: buttons, direct page entry, zoom, Two Pages, Continuous Scroll, scroll tracking, and return | Page calculations, preference normalization, PDF rendering internals, and layout artifacts remain in Vitest |
| 11 | A user dismisses the folder hint, creates a folder by dragging documents together, and finds both preferences after reload | Accepted `folder-persistence.spec.ts`: visible hint dismissal, document-card pointer drag, named folder creation, filtered contents, and reload persistence | Folder API ownership, model derivation, and preference serialization remain in Vitest |
| 12 | A user changes voice and speed, resumes playback, and keeps those choices | Merged into `playback-controls.spec.ts`: visible F1-to-F2 selection, keyboard speed changes, resume/pause, and reload persistence run in the existing TXT portion | Playback-plan recreation, config update ordering, audio-rate application, provider policies, and voice resolution remain in Vitest |
| 13 | A visible PDF sentence highlight remains correctly positioned after responsive layout changes | Accepted `pdf-responsive.spec.ts`: narrow to the mobile reader, widen again, and require the same readable page, navigator state, and in-page sentence highlight after each repaint | PDF scaling, text-layer geometry, block matching, and highlight rectangle calculations remain in Vitest |
| 14 | An EPUB remains readable and stops active playback when its reader layout changes | Merged into `playback-controls.spec.ts`: the existing EPUB start narrows to the mobile reader, requires playback to stop and the menu and book content to remain usable, then widens again | EPUB rendition resizing, placement mapping, and playback state transitions remain in Vitest |
| 15 | A keyboard user can operate Settings, and a direct reader route survives reload and returns to the library | Merged into `anonymous-entry.spec.ts` and `text-markdown-reader.spec.ts`: keyboard activation, dialog focus entry and restoration, labelled controls, direct-route reload, readable content, and visible return | Focus primitives, route policy, and reader-state restoration remain in Vitest; authenticated routing stays deferred until a controlled authenticated state exists |

The initial core gate did not require folder drag-and-drop, responsive reader
behavior, voice/speed customization, provider-specific coverage, or
authenticated routing. The first three are now accepted follow-on journeys;
provider-specific coverage and authenticated routing remain deferred and must
not retroactively delay acceptance of the core suite.

---

## Phase 2: Create the First Replacement Browser Test

Status: complete.

### Walkthrough 1: Anonymous first-run entry

Observed with computer use on 2026-08-03 against the production build at
`http://localhost:3003` after clearing browser data.

- Purpose: enter OpenReader anonymously from the public landing page and reach
  an interactable empty library after completing the first-run privacy flow.
- Initial state: no authenticated account, cookies, local storage, or existing
  anonymous browser state.
- Public route: `/` visibly renders the OpenReader marketing page with the
  heading `Hear every document, highlighted word by word.` and the link
  `Open the reader`.
- Visible actions and states:
  1. Activate the `Open the reader` link.
  2. Observe navigation to `/app` and the modal dialog
     `Privacy & Data Usage` over the empty library.
  3. Check `I have read and agree to the` and observe that `Continue` becomes
     enabled.
  4. Activate `Continue` and observe the changelog inside the Settings dialog.
  5. Activate `Back to settings`, then activate the visible `Close dialog`
     button to close Settings.
  6. Activate `Decline Non-Essential` on the cookie notice.
- Final visible success: the URL remains `/app`; the `OpenReader` heading,
  `Choose File` upload controls, accepted-format hint, and `0 items` library
  status are visible with no modal or cookie notice remaining.
- Recovery behavior observed: the privacy `Continue` button is disabled until
  the agreement checkbox is selected. No application error appeared.
- Screenshots: none required; the accessible DOM states fully described the
  journey.
- Vitest ownership: anonymous-session persistence, consent storage, changelog
  version comparison, and request policy remain deterministic non-browser
  concerns. Playwright owns only the visible first-run path and usable-library
  result.
- Inventory correction: the current product does not redirect anonymous `/app`
  visitors to sign-in. The public landing remains at `/`, while anonymous users
  may enter the library at `/app` and are offered `Connect` and
  `Create account` links there.

After the first computer-use walkthrough identifies the first accepted journey:

1. Add the first spec under the retained `tests/e2e` directory.
2. Use a fresh browser context and real user/session ownership; do not recreate
   the deleted namespace header.
3. Give every test execution unique account and document identities so parallel
   work cannot collide.
4. Keep actions and assertions inline in the first test.
5. Use the retained per-project screenshots, traces, and result artifacts for
   diagnostics.
6. Run the test in Chromium, Firefox, and WebKit during the same parallel run.
7. Remove `--pass-with-no-tests` from CI once the first accepted spec exists.

Do not restore the old global teardown, namespace contract, mock TTS response,
or monolithic helper module.

Gate:

- the first journey has a completed computer-use record;
- the harness contains no copied old suite code;
- the first test passes in Chromium, Firefox, and WebKit in one concurrent run;
- the run uses the configured 50% worker pool and has no accidental serial test
  groups or project dependencies;
- `pnpm test` continues to run Vitest and `pnpm test:e2e` explicitly runs the
  new browser suite.

### Phase 2 acceptance evidence

- The browser walkthrough above was completed before the spec was created.
- `tests/e2e/anonymous-entry.spec.ts` contains the observed journey inline and
  introduces no shared helper, namespace, teardown, or API-level shortcut.
- `pnpm exec playwright test tests/e2e/anonymous-entry.spec.ts --reporter=list`
  ran Chromium, Firefox, and WebKit together using three workers: all three
  projects passed in 3.7 seconds.
- The first diagnostic run exposed a test-boundary error: the Headless UI
  dialog wrapper has no visible box although its panel is visible. The accepted
  test asserts the visible dialog headings while keeping actions scoped to the
  accessible dialog roles.
- CI no longer uses `--pass-with-no-tests` now that an accepted replacement
  spec exists.
- `pnpm test` remains the Vitest command: 110 files and 553 tests passed after
  the browser spec was added.
- `pnpm exec tsc --noEmit` passed with the new spec included.

## Phase 3: Rebuild Core Reading Journeys

Status: complete; priorities 1–7 are accepted.

### Walkthrough 2: Upload supported documents into the library

Observed with computer use on 2026-08-03 against the production build at
`http://localhost:3003`.

- Purpose: select representative PDF, EPUB, and TXT documents together through
  the visible library upload surface and confirm that each becomes an
  independently accessible library item.
- Initial state: an anonymous, onboarded session at an empty `/app` library.
  A fresh automated context must establish that same state through the already
  accepted first-run UI rather than through an API or stored-state injection.
- Controlled files:
  - `tests/files/sample.pdf` (`PDF document, version 1.7`);
  - `tests/files/sample.epub` (valid EPUB);
  - `tests/files/multilingual-sample.txt` (UTF-8 multilingual text).
- Visible actions and states:
  1. Use the large upload surface labelled by `Drop your file(s) here, or click
     to select` and the accepted-format hint.
  2. Open its real file chooser. The observed chooser accepts multiple files.
  3. Select the PDF, EPUB, and TXT fixtures in one user action.
  4. Observe the visible upload state: `Uploading`, `0/3`, `Upload progress 0%`,
     the current filename, and `Uploading file...` in the main surface.
  5. Observe the upload state disappear and the library populate without route
     navigation.
- Final visible success:
  - document links `sample.pdf`, `sample.epub`, and
    `multilingual-sample.txt` are visible;
  - type filters report `PDF 1`, `EPUB 1`, and `Text 1`;
  - the library status reports `1 PDF • 1 EPUB • 1 Text Doc` and `3 items`;
  - each format exposes its expected reader route through a visible document
    link: `/pdf/...`, `/epub/...`, and `/html/...` respectively.
- Visible failure or recovery: none appeared for supported input. The transient
  upload status is useful progress feedback, but the durable test completion
  signal is the three visible library links and final item/type summary.
- Screenshots: none required; the accessible DOM captured both the upload and
  completed-library states.
- Vitest ownership: extension/MIME validation, presign/finalize behavior,
  hashing, canonical identity, blob persistence, preview generation, and route
  error mappings remain outside Playwright. The browser test owns only file
  selection, visible progress, and visible library arrival.

#### Walkthrough 2 acceptance evidence

- `tests/e2e/supported-upload.spec.ts` repeats the accepted first-run setup
  inline, then clicks the observed large upload surface and uses the resulting
  multi-file chooser. It introduces no helper, namespace, teardown, or direct
  application API call.
- The test asserts the observed upload indicator, the three durable document
  links, their reader-route families, the per-type counts, and the final
  three-item summary.
- `pnpm exec playwright test tests/e2e/supported-upload.spec.ts --reporter=list`
  ran Chromium, Firefox, and WebKit together using three workers: all three
  projects passed in 3.3 seconds.
- The parallel run used three independent anonymous sessions to upload the same
  canonical fixtures without a test namespace or cross-session collision.
- The first combined-suite run showed that the unchanged Settings heading was
  not a valid readiness signal after activating `Back to settings`; under load,
  Escape could arrive while the view was still transitioning. A later
  seven-worker run proved that keyboard-only dismissal could still leave the
  modal covering the library. The product now exposes an accessible
  `Close dialog` button, and every accepted test waits for and activates that
  observed control before asserting that Settings is hidden.
- `pnpm exec playwright test --reporter=list` then ran both accepted specs in
  Chromium, Firefox, and WebKit together using six workers: all six cases passed
  in 5.2 seconds.
- After adding the upload journey, `pnpm test` still passed all 110 Vitest files
  and 553 tests, and `pnpm exec tsc --noEmit` passed.
- With two accepted specs now repeating the same first-run setup, a narrow
  onboarding fixture is eligible for Phase 5 review. It has not been extracted
  yet because the accepted journey remains readable inline.

### Walkthrough 3: Reject an unsupported file with useful feedback

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`, first before and then after correcting the product.

- Purpose: select an unsupported file through the visible upload interface and
  understand why it was not added to the library.
- Initial state: an anonymous, onboarded session at `/app`. The walkthrough used
  an existing three-item library to prove that rejection did not change its
  contents; the automated journey will use an empty isolated library so the
  unchanged result is unambiguous.
- Controlled file: `tests/files/unsupported.xyz`, a harmless text fixture whose
  extension is outside the accepted format list.
- Visible actions and states:
  1. Activate the sidebar `Choose File` control and observe the `Add Documents`
     dialog.
  2. Observe the `Upload Files` view, its `Choose File` button, drop target, and
     accepted-format hint.
  3. Use the real file chooser to select `unsupported.xyz`.
- Product defect found: the original build silently ignored the rejected file.
  The dialog remained open and the library stayed unchanged, but no visible or
  accessible explanation appeared. This was treated as a product bug rather
  than accepted as the test contract.
- Product correction: the upload component now handles rejected dropzone files
  and exposes the message as an alert. The rebuilt application visibly reports
  `unsupported.xyz is not supported. Choose a PDF, EPUB, TXT, MD, or DOCX file.`
- Final visible success: the alert is present, the upload dialog remains usable,
  the unsupported filename does not appear as a library link, and the library
  item count is unchanged.
- Screenshots: none required; the accessible DOM captured the dialog, alert,
  accepted formats, and unchanged library summary.
- Vitest ownership: extension and MIME policy details remain deterministic
  validation concerns. Playwright owns the user's visible rejection and the
  absence of an added library item.

### Walkthrough 4: Open and visibly read a PDF

Observed with computer use on 2026-08-04 against the rebuilt production build
at `http://localhost:3003`.

- Purpose: open a PDF from the library and confirm that the reader becomes
  useful rather than merely reaching a reader route.
- Initial state: an anonymous, onboarded session at `/app` with `sample.pdf`
  already visible. The automated journey will create that state through the
  visible upload chooser in its own fresh browser context.
- Visible actions and states:
  1. Activate the exact document link `sample.pdf`.
  2. Observe navigation to `/pdf/<document-id>`.
  3. Observe the intermediate `Opening document` preparation state and its
     progress bar.
  4. Observe the preparation state disappear and the reader become visible.
- Final visible success:
  - the reader heading is `sample.pdf`;
  - extracted page text begins with `Chapter One` and includes the stable
    integration-test sentence;
  - playback controls and the `Playback position` slider are available;
  - PDF navigation reports `1 / 2`, with `Previous page` disabled and
    `Next page` available;
  - `Back to documents` returns visibly to `/app`.
- Visible failure or recovery: none appeared on the rebuilt product.
- Screenshots: none required; the accessible DOM captured the preparation and
  ready states plus the readable page content.
- Vitest ownership: parsing, extracted artifacts, pagination algorithms,
  bootstrap events, and storage lifecycle remain outside Playwright. The
  browser journey owns upload, navigation, visible readiness, readable content,
  and return navigation.

### Walkthrough 5: Open and visibly read an EPUB

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`, first before and then after correcting the product.

- Purpose: open an EPUB from the library and confirm that real book content is
  rendered, not only the surrounding reader controls.
- Initial state: an anonymous, onboarded session at `/app` with `sample.epub`
  already visible. The automated journey will upload the fixture through the
  visible chooser in its own fresh browser context.
- Visible actions and states:
  1. Activate the exact document link `sample.epub`.
  2. Observe navigation to `/epub/<document-id>` and the intermediate
     `Opening document` preparation state.
  3. Observe the reader heading, zoom, chapter, section, and playback controls.
  4. Inspect the visible book surface for readable EPUB content.
- Product defect found: the original build showed a blank book surface after
  preparation even though the reader controls and table of contents existed.
  Changing parent callback identities caused the rendition-host effect to tear
  down the newly ready rendition and replace it with one that never received
  the authoritative startup display command.
- Product correction: the rendition host now keeps the latest callbacks in a
  ref and recreates the EPUB rendition only when the document data changes.
  The rebuilt application visibly renders the EPUB iframe content.
- Final visible success:
  - the reader heading is `sample.epub`;
  - `Show chapters`, `Previous section`, and `Next section` are available;
  - the rendered book shows `The Project Gutenberg eBook of The Wonderful
    Wizard of Oz`, its title and author, and a chapter table beginning with
    `Chapter I. The Cyclone`;
  - playback controls and the `Playback position` slider are available.
- Visible failure or recovery: the blank-reader defect was corrected before a
  test was written. The replacement test must assert readable book content so
  the broken controls-only state cannot pass.
- Screenshots: a visual inspection confirmed the original blank book surface;
  after rebuilding, the accessible DOM exposed the complete rendered book
  content and chapter table.
- Vitest ownership: EPUB parsing, spine coordinates, location mapping,
  placement, and controller state remain deterministic non-browser concerns.
  Playwright owns navigation and actual visible book readiness.

#### Walkthroughs 3–5 acceptance evidence

- `DocumentUploader` now handles rejected files and renders rejection messages
  with alert semantics; `unsupported-upload.spec.ts` proves the exact visible
  feedback and unchanged zero-item library.
- `EpubRenditionHost` no longer destroys and recreates a ready rendition when a
  parent callback identity changes; `epub-reader.spec.ts` proves that rendered
  book headings, author text, and the first chapter link are visible inside the
  book surface.
- `pdf-reader.spec.ts` proves the PDF route, title, two independently rendered
  text-layer strings, playback controls, page navigation, and visible return to
  the library.
- The Settings modal now exposes its standard accessible close button. All five
  accepted journeys use it and assert that the modal is gone before interacting
  with the library.
- The three-test batch ran as nine cases across Chromium, Firefox, and WebKit
  using seven workers; all nine passed in 19.2 seconds.
- The complete five-spec suite ran as 15 cases across the three browsers using
  seven workers; all 15 passed in 10.5 seconds. This is the configured 50%
  worker cap on the 14-logical-CPU development machine.
- A diagnostic full-suite attempt used a manually started server without the
  config's `DISABLE_AUTH_RATE_LIMIT=true` environment and visibly reached
  `Unable to start an anonymous session (rate limited or network error).` The
  accepted run used the production server configuration declared by the
  Playwright harness; no retry logic or serialized execution was added.
- `pnpm test` passed all 110 Vitest files and 553 tests, `pnpm exec tsc
  --noEmit` passed, `pnpm build` passed, and `git diff --check` passed after the
  product fixes and three new specs.

### Walkthrough 6: Read plain text and semantic Markdown

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`.

- Purpose: confirm that TXT remains literal readable text while Markdown is
  rendered with meaningful document structure and inline semantics.
- Initial state: an anonymous, onboarded session at `/app` with
  `multilingual-sample.txt` already present. The walkthrough then uploaded the
  controlled `tests/files/sample.md` fixture through the visible file chooser.
  The automated journey will upload both fixtures in its own fresh context.
- Visible actions and states:
  1. Activate the exact `multilingual-sample.txt` document link.
  2. Observe navigation to `/html/<document-id>`, the filename heading, literal
     language-labelled text blocks, and playback controls.
  3. Activate `Back to documents`.
  4. Upload `sample.md` through the `Add Documents` dialog's real file chooser.
  5. Observe the Markdown preview already exposing structured content, then
     activate the exact `sample.md` document link.
  6. Observe navigation to `/html/<document-id>` and the rendered Markdown.
- Final visible success:
  - TXT visibly preserves its English, French, Spanish, Arabic, Hindi,
    Japanese, Chinese, and Thai text as literal blocks;
  - Markdown visibly renders `Sample Markdown` as a level-one heading,
    `Section One` as a level-two heading, `Item 1` and `Item 2` as a list,
    `OpenAI` as a real link, `strong` as bold text, `emphasis` as emphasized
    text, and the JavaScript line as code;
  - both readers expose playback controls and the `Playback position` slider.
- Visible failure or recovery: none appeared. The semantic distinction is
  durable enough for one combined browser journey rather than separate shallow
  route tests.
- Screenshots: none required; the accessible DOM captured literal TXT blocks
  and each semantic Markdown element.
- Vitest ownership: decoding, Markdown-to-block transformation, inline-markup
  rules, and highlight mapping remain in deterministic tests. Playwright owns
  the visible formatting distinction and usable reader result.

### Walkthrough 7: Convert DOCX to PDF and read the result

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`, first before and then after correcting the product.

- Purpose: upload a Word document, observe that conversion completes as a PDF
  library item, and open readable converted content.
- Initial state: an anonymous, onboarded session at `/app`. The walkthrough used
  the restored controlled fixture `tests/files/sample.docx`; the automated
  journey will use an empty isolated library so the converted item is unique.
- Visible actions and states:
  1. Open `Add Documents` from the sidebar `Choose File` control.
  2. Select `sample.docx` through the real file chooser.
  3. Observe `Uploading`, `0/1`, `Upload progress 0%`, the source filename
     `sample.docx`, and `Uploading file...` while the operation is active.
  4. Wait for the durable library result rather than treating disappearance of
     transient progress as conversion success.
- Product defect found: the compute worker completed DOCX conversion
  successfully, but the upload client treated the server's `202` conversion
  response as a terminal error. The progress UI disappeared and no converted
  document appeared even after the worker produced the PDF artifact.
- Product correction: the initial `202` response now leads the client to an
  authenticated, operation-scoped SSE stream for each pending conversion. The
  upload remains active until the worker reports success, failure, cancellation,
  or the bounded timeout. After success the client makes one idempotent finalize
  request to register the durable PDF; it does not poll the finalize endpoint.
- Rebuilt result: the progress state remained active until the converted item
  appeared; the library gained a PDF named `sample.pdf`, its PDF count and total
  item count increased, and the new document linked to `/pdf/<document-id>`.
- Final visible success after opening the converted item:
  - the reader heading is `sample.pdf`;
  - readable first-page content begins `Demonstration of DOCX support in
    calibre` and describes the calibre DOCX input plugin;
  - PDF navigation reports `1 / 8`, with `Previous page` disabled and
    `Next page` available;
  - playback controls and the `Playback position` slider are visible.
- Screenshots: none required; the accessible DOM and worker log captured the
  original missing-library defect, and the rebuilt DOM captured the converted
  item and readable PDF.
- Vitest ownership: conversion IDs, operation state, artifact persistence,
  leases, idempotent finalize receipts, timeout/abort behavior, and cleanup
  remain deterministic concerns. Playwright owns the visible source upload,
  converted PDF arrival, navigation, and readable result.

#### Walkthroughs 6–7 acceptance evidence

- `text-markdown-reader.spec.ts` uploads TXT and Markdown together, opens both
  through their visible links, proves the TXT content remains literal, and
  asserts the observed Markdown headings, list content, link, code, and reader
  controls.
- `docx-conversion.spec.ts` observes the DOCX source filename and active upload
  state, verifies that the browser opens the operation SSE request, waits for
  the durable converted `sample.pdf` link, then proves the eight-page PDF reader
  exposes converted Word content and playback controls.
- `uploadDocumentSources` now follows the returned worker operation through the
  authenticated `/api/documents/blob/upload/events` SSE proxy, then makes one
  idempotent finalize call after success. `document-upload-client.vitest.spec.ts`
  proves the event-driven client lifecycle, and
  `document-upload-events-route-worker-proxy.vitest.spec.ts` proves that the
  proxy re-derives conversion ownership before exposing the worker stream.
- The two-test batch ran as six cases across Chromium, Firefox, and WebKit using
  six workers; all six passed in 23.5 seconds. The three DOCX conversions
  overlapped, and the slowest conversion plus reader preparation completed in
  21.9 seconds without serializing the browser matrix.
- The complete seven-spec suite ran as 21 cases across the three browsers using
  the configured seven-worker cap; all 21 passed after the SSE correction in
  54.4 seconds, including three concurrent DOCX conversions.
- `pnpm test` passed all 112 Vitest files and 558 tests, `pnpm exec tsc
  --noEmit` passed, `pnpm build` passed, and `git diff --check` passed after the
  DOCX lifecycle correction and two new specs.

Completed in this phase:

- supported and unsupported uploads;
- PDF readiness and visible content;
- EPUB readiness and visible content;
- TXT and Markdown readiness and meaningful rendering;
- DOCX conversion and opening the resulting PDF.

For each journey, first decide whether setup and lifecycle details belong in
Vitest. Browser coverage should begin at the visible user action and end at the
visible user result.

Gate:

- every accepted test has its own walkthrough record;
- every reader failure distinguishes a visible error from a timeout;
- no test queries application APIs to prove its main user outcome;
- each test passes independently and as part of a concurrent Chromium, Firefox,
  and WebKit run.

## Phase 4: Rebuild Interaction Journeys

Status: complete for the accepted anonymous interaction scope; deletion,
minimal per-document playback, PDF navigation, folder drag-and-drop
persistence, voice/speed persistence, responsive PDF and EPUB behavior, and
keyboard/dialog and direct-reader routing are accepted. Authenticated routing
remains explicitly deferred until a controlled authenticated state exists.

### Walkthrough 8: Cancel and confirm document deletion

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`.

- Purpose: prove that deletion is reversible at the confirmation boundary and
  removes the selected document only after explicit confirmation.
- Initial state: an anonymous, onboarded library containing five documents.
  The automated journey creates an isolated one-document library by uploading
  `sample.md` through the visible chooser.
- Visible actions and states:
  1. Activate `Delete sample.md` and observe the `Delete Document` dialog and
     the question `Are you sure you want to delete sample.md?`.
  2. Press Escape. The dialog closes, `sample.md` remains, and keyboard focus
     returns to `Delete sample.md`.
  3. Reopen the dialog and activate its `Delete` button.
- Final visible success: the document link disappears, the library changes to
  `0 items`, the zero-count `All Documents` and `Text` filters remain usable,
  and the empty-library upload surface returns.
- Product defect found and corrected: deletion waited for best-effort TTS cache
  cleanup before returning the durable library result. Under concurrent load
  that background work could hold the dialog open after ownership had already
  been removed. Ownership deletion now completes first and cache cleanup is
  scheduled after the response; the journey still observes both the durable
  library state and the dialog closing as separate outcomes.
- Dialog keyboard behavior now makes the safe Cancel action the initial focus,
  closes explicitly on Escape, and leaves Enter to the focused native button.
  This removes the previous path where Enter on Cancel could also invoke the
  dialog-wide confirmation handler.
- Vitest ownership: ownership checks, blob cleanup, leases, and storage
  lifecycle remain deterministic tests.

### Walkthrough 9: Minimal playback controls for every document journey

Observed with computer use on 2026-08-04 against the production build at
`http://localhost:3003`.

- Purpose: keep playback coverage shallow while proving that every accepted
  reader journey can expose and operate the shared Play/Pause control.
- Initial state: an anonymous, onboarded library containing TXT, Markdown,
  EPUB, PDF, and a DOCX-converted PDF.
- Visible actions and states:
  1. Open each document through its library link and wait for its reader title
     and enabled `Play` button.
  2. Focus `Play`, press Enter, and observe the control become `Pause` while
     retaining focus.
  3. Press Space and observe the control return to focused `Play`.
  4. Activate `Back to documents` before opening the next document.
- Actual progress check: the manual TXT walkthrough allowed real synthesis to
  finish and observed the playback slider advance from 0 to 9 and then 16.25.
  The per-document automated smoke deliberately asserts only the control cycle;
  detailed timing, alignment, and progress remain separate from this minimal
  cross-format contract.
- Format results: TXT, Markdown, EPUB, native PDF, and the converted DOCX PDF
  all exposed the expected controls. Full background synthesis of the sample
  EPUB section took roughly 187 seconds locally, confirming that repeating a
  progress assertion for every format would turn a smoke journey into an
  expensive provider test.
- Product defects found and corrected:
  - Pause during playback startup did not invalidate the pending request, so a
    stale session could continue starting after the UI had returned to Play.
    Pending session creation is now abortable and request cancellation is
    propagated to the worker call.
  - HTML and EPUB returned to the library through plain links and skipped the
    playback cleanup used by PDF. Their Back actions now stop playback and
    disable progress persistence before navigating.
- Automated setup uses a real four-file chooser action, followed by a DOCX
  upload through the observed `Add Documents` dialog. The native and converted
  PDFs intentionally appear as two same-named `sample.pdf` entries and both are
  exercised.

#### Walkthroughs 8–9 acceptance evidence

- `document-deletion.spec.ts` passed in Chromium, Firefox, and WebKit as three
  concurrent cases in 5.0 seconds during its focused acceptance run.
- `playback-controls.spec.ts` passed in Chromium, Firefox, and WebKit together
  as three concurrent cases in 1.7 minutes. Each case exercised all five
  accepted document journeys using keyboard Play/Pause interaction.
- The full harness keeps `fullyParallel: true` and `workers: '50%'`. The 24 core
  reader/library cases run first; after that gate succeeds, the three playback
  browser projects run together. This preserves the three-engine concurrency
  requirement without allowing intentionally long synthesis work to obscure
  unrelated core failures.
- A clean full-core diagnostic run used the configured seven-worker cap and all
  24 core cases passed before the playback stage began.
- The complete replacement suite then passed all 27 cases in 3.0 minutes: all
  24 core cases passed across Chromium, Firefox, and WebKit before the three
  playback projects ran concurrently and passed across the same browser matrix.
- That full run exposed and verified one additional product fix: supported
  native uploads had finished storing every byte but their finalize response
  waited for best-effort preview generation through the single compute worker.
  Preview enqueueing is now scheduled after the response, while user-requested
  DOCX conversion remains awaited. The formerly stalled WebKit three-document
  upload completed in 4.5 seconds in the accepted run.

### Walkthrough 10: Navigate PDF pages and page modes

Observed with computer use on 2026-08-11 against the rebuilt production build
at `http://localhost:3003`.

- Purpose: prove that the visible PDF surface follows page navigation and that
  Single Page, Two Pages, and Continuous Scroll behave as distinct usable
  reader modes.
- Initial state: an anonymous, onboarded library containing the two-page
  `sample.pdf`. The automated journey uploads the fixture through the visible
  chooser in a fresh browser context.
- Visible actions and states:
  1. Move from page one to page two and observe both the distinct `Chapter Two`
     surface and the `2 / 2` navigator state.
  2. Open direct page entry, enter page one with the keyboard, and observe the
     popover close, focus return to `1 / 2`, and `Chapter One` return.
  3. Increase zoom from 100% to 110% and return it to 100%.
  4. Select Two Pages and observe both labelled PDF page regions in the
     viewport.
  5. Select Continuous Scroll, navigate to page two, and observe page two move
     into the viewport. Scroll back to page one and observe the navigator track
     the visible page.
  6. Return visibly to the library.
- Product defects found and corrected:
  - Continuous Scroll changed the current-page state without moving the scroll
    surface, so Previous, Next, and direct page entry could report one page
    while another remained visible. Page commands now scroll the matching page
    region into view, and manual scrolling updates the current-page state from
    the page with the greatest visible area.
  - Direct page entry remained open after Enter in Chromium, Firefox, and
    WebKit even after the page changed. Confirmation now closes and remounts the
    popover in its closed state and restores focus to the page trigger.
  - PDF page wrappers previously had no page-level semantics. Each rendered
    page is now a labelled `PDF page N` region, allowing both assistive
    navigation and a user-visible viewport assertion without screenshot
    baselines or private application state.
  - Under parallel WebKit load, Continuous Scroll could briefly align page two
    and then synchronize back to page one while its text layer reflowed. A
    programmatic page change now holds scroll synchronization through text-layer
    readiness and aligns from live element geometry before manual scrolling
    resumes control.
- Focused acceptance: `pdf-navigation.spec.ts` passed concurrently in Chromium,
  Firefox, and WebKit as three cases in 37.0 seconds, with each browser journey
  itself completing in under four seconds after startup.
- Loaded-browser stress acceptance: five concurrent WebKit repetitions of the
  PDF navigation journey passed in 34.0 seconds, and five concurrent Chromium
  repetitions of the deletion journey passed in 32.9 seconds.
- All accepted onboarding setups now wait for the visible Settings panel to
  finish entering and then detach after closing. This matches the computer-use
  pace and prevents an invisible transition portal from intercepting the next
  visible action.
- Full-suite acceptance: all 30 cases passed in 1.7 minutes with the configured
  seven-worker cap. The 27 core cases passed across Chromium, Firefox, and
  WebKit before the three dependent playback projects passed concurrently
  across the same browser matrix.

### Walkthrough 11: Create and persist a folder by dragging documents together

Observed with computer use on 2026-08-12 against the rebuilt production build
at `http://localhost:3003`.

- Purpose: prove that the library's visible document-on-document drag gesture
  creates a named folder and that both membership and the active folder survive
  a reload.
- Initial state: an anonymous, onboarded library containing distinct TXT,
  EPUB, and PDF documents. The automated journey uploads all three through the
  visible chooser in a fresh browser context; the third document distinguishes
  a real two-document folder filter from an unfiltered library.
- Visible actions and states:
  1. Observe the instruction `Drag files onto each other to make folders. Drop
     into the sidebar to move.`, its `Dismiss hint` control, and all three
     uploaded document cards.
  2. Activate `Dismiss hint` and observe the instruction disappear.
  3. Drag the `multilingual-sample.txt` card onto the `sample.epub` card with a
     real mouse pointer sequence.
  4. Observe the focused `Create New Folder` dialog, enter `Reading List`, and
     press Enter.
  5. Observe the `Reading List 2` folder, the TXT and EPUB cards, and the PDF
     card hidden by the selected folder filter.
  6. Reload and observe the same two-item folder membership and filtered
     document surface, with the dismissed instruction still absent.
- Browser-authoring finding: Playwright's HTML5 `dragTo` helper does not model
  this product interaction because OpenReader deliberately uses the React DnD
  touch backend with mouse events so mouse and touch share one behavior. The
  accepted test uses visible card geometry and a normal mouse down, movement,
  and mouse up sequence matching the successful computer-use walkthrough; it
  does not dispatch synthetic application events or mutate internal state.
- Full-load follow-up: the touch backend arms mouse input on its next browser
  task even though its configured mouse delay is zero. A synthetic
  down-and-move sequence completed inside that task and occasionally never
  began a drag. The journey now models a brief physical press, requires the
  source card's visible selected state, requires the target card's visible drop
  feedback, and only then releases. Five concurrent Chromium repetitions
  passed in 31.3 seconds; no retry or worker reduction was added.
- No product defect was observed in the accepted path.
- Final-inventory follow-up: a fresh-origin computer-use walkthrough confirmed
  that `Dismiss hint` removes the instruction immediately and that it remains
  absent after reload without affecting either uploaded document. The
  assertions were merged into this existing journey rather than adding a
  separate preference test. Chromium, Firefox, and WebKit passed the updated
  journey concurrently as three cases in 4.8 seconds.
- Focused acceptance: `folder-persistence.spec.ts` passed concurrently in
  Chromium, Firefox, and WebKit as three cases in 8.8 seconds.
- The first enlarged full-matrix run exposed a cold-start expectation defect in
  existing reader tests: a successful local PDF layout occupied the configured
  compute threads for 41 seconds while Firefox visibly remained on `Opening
  document`. Reader readiness now has a 60-second assertion budget while still
  requiring the final heading, content, and controls; retries, worker count,
  and the 50% parallel cap remain unchanged.
- The dependent playback smoke now uses the dedicated DOCX journey's accepted
  60-second conversion budget before requiring the second `sample.pdf`. It
  still requires the converted document and exercises its playback controls;
  the change does not accept upload progress or a pending conversion as
  success. Its five sequential readers use the same 60-second readiness
  contract, within an explicit three-minute journey budget.
- Full-suite acceptance after these additions: all 33 cases passed in 3.0
  minutes with the configured seven-worker (`50%`) cap. The 30 core cases
  passed across Chromium, Firefox, and WebKit before all three dependent
  playback projects ran concurrently and passed.

### Walkthrough 12: Change voice and speed, then resume playback

Observed with computer use on 2026-08-13 against the rebuilt production app at
`http://localhost:3003`.

- Purpose: prove that an anonymous user can customize the shared playback
  controls, explicitly resume after settings that rebuild the playback plan,
  and find the same selections after reloading the reader.
- Initial state: an anonymous, onboarded library containing
  `multilingual-sample.txt`, opened in the TXT reader with voice F1 and both
  speed controls at 1x.
- Visible actions and states:
  1. Start playback, observe `Play` become `Pause`, then pause explicitly so
     this settings journey does not compete with the separate synthesis smoke.
  2. Open the voice list, choose F2, and observe the control return visibly as
     F2 while playback is stopped for the new plan.
  3. Open the speed popover and use the keyboard to move Native model speed
     from 1x to 1.1x. The popover closes while the plan is reacquired, and the
     trigger visibly changes to 1.1x.
  4. Reopen the speed popover and use the keyboard to move Audio player speed
     from 1x to 1.1x. The trigger visibly changes to `1.1x • 1.1x`.
  5. Resume playback, observe `Pause`, then pause explicitly.
  6. Reload and observe voice F2, `1.1x • 1.1x`, and an enabled `Play` control.
- Product accessibility defect found and corrected: both speed inputs exposed
  only the generic role `slider`, and the compact voice button's accessible
  name was only its selected value. The speed inputs now expose `Native model
  speed` and `Audio player speed`; the voice control exposes `Voice: <value>`.
  These names are part of the real journey rather than a separate duplicate
  accessibility suite.
- Product interaction defect found under full concurrent load and corrected:
  speed and voice controls remained clickable while a prior settings change
  was rebuilding the playback plan. Their visible value could update before
  the control was ready to reopen, so a user's click could be discarded. Both
  controls now expose and honor the same disabled processing state as the
  playback controls; the journey waits for the visible trigger to become
  enabled rather than sleeping or retaining a detached slider.
- Browser-authoring finding: a native-speed key change commits immediately and
  closes the popover while the new playback plan is acquired. The accepted
  journey requires the changed trigger before reopening the popover for the
  audio-rate change; it does not retain or query a detached slider.
- Provider scope: the walkthrough uses the locally available F1/F2 voices and
  a single selected voice. Multi-voice Kokoro and other provider-specific
  behavior remains deferred until that exact environment succeeds through
  computer use.
- A full-matrix diagnostic also found that the landing-page cookie banner can
  visibly cover the `Open the reader` CTA in WebKit. The first-entry journey
  now declines optional cookies before activating that link, matching the
  actual visible UI instead of racing the banner animation.
- Initial focused acceptance: `playback-settings.spec.ts` passed concurrently in
  Chromium, Firefox, and WebKit as three cases in 37.0 seconds. The corrected
  anonymous first-entry journey passed in the same three browsers in 34.4
  seconds.
- Full-suite acceptance: all 36 cases passed in 1.8 minutes with the configured
  seven-worker (`50%`) cap. All 30 core cases passed first; both playback
  journeys then passed in Chromium, Firefox, and WebKit, with the six playback
  cases scheduled concurrently.

### Walkthrough 13: Keep a PDF highlight aligned through responsive resizing

Observed with computer use on 2026-08-18 against the production build at
`http://localhost:3003`.

- Purpose: prove that a visible PDF sentence highlight is restored on the same
  readable page after the PDF canvas and text layer repaint for narrow and wide
  reader layouts.
- Initial state: an anonymous library containing the two-page `sample.pdf`,
  opened on page two in Single Page mode with `Chapter Two` visibly
  highlighted. The automated journey uploads the same fixture in a fresh
  browser context and begins on its default first page.
- Visible actions and states:
  1. Observe the selected PDF page, its readable chapter text, navigator state,
     and gray sentence highlight at a 1280-pixel-wide desktop layout.
  2. Narrow the actual browser viewport to 600 by 800 pixels.
  3. Observe the mobile `Menu` control, the same selected page and navigator,
     readable chapter text, and the sentence highlight still contained within
     the PDF page after the responsive repaint.
  4. Widen the viewport to 1280 by 900 pixels and observe the desktop settings
     control plus the same page, text, navigator, and in-page highlight again.
- Persistence correction before observation: the walkthrough browser had
  retained Continuous Scroll from the earlier navigation journey. It was
  explicitly returned to Single Page through the visible Document Settings
  dialog before judging the responsive contract; the automated journey uses a
  fresh anonymous session whose default is Single Page.
- Testability boundary: sentence highlighting is a graphical overlay with no
  suitable accessible role. The product exposes a narrow
  `pdf-sentence-highlight` test id on that visible overlay; the test does not
  use the PDF CSS class or private reader state and additionally requires the
  highlight rectangle to remain inside the labelled PDF page region.
- No product defect was observed. The highlight remained visibly anchored to
  `Chapter Two` after narrowing and after widening again.
- Focused acceptance: `pdf-responsive.spec.ts` passed concurrently in
  Chromium, Firefox, and WebKit as three cases in 34.0 seconds. The individual
  journeys completed in 2.0, 2.8, and 3.1 seconds respectively.
- Full-load follow-up: the first enlarged matrix exposed that the repeated
  onboarding helper could activate `Back to settings` while the Settings panel
  was still entering. Firefox visibly remained on the changelog. The helper
  now requires the existing transition to finish before the Back action and
  again before closing Settings. Five concurrent Firefox upload/onboarding
  repetitions passed in 35.1 seconds.
- Full-suite acceptance: all 39 cases passed in 1.7 minutes with the configured
  seven-worker (`50%`) cap. All 33 core cases passed across Chromium, Firefox,
  and WebKit before the six dependent playback cases ran across the same three
  engines and passed.
- Repository verification: `pnpm test` passed 112 Vitest files and 559 tests;
  `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, and `git diff --check`
  all passed.
- Vitest ownership: scaling calculations, text-layer geometry, parsed-block
  matching, and highlight rectangle algorithms remain deterministic tests.
  Playwright owns the visible page and highlight surviving real viewport
  changes.

### Walkthrough 14: Keep an EPUB usable and stop playback during resizing

Observed with computer use on 2026-08-18 against the production build at
`http://localhost:3003`.

- Purpose: prove that an EPUB remains readable while its desktop reader changes
  to the mobile layout, and that active playback safely stops during the
  rendition resize.
- Initial state: an anonymous library containing `sample.epub`, opened at a
  1280 by 900 desktop viewport with the title page, contents, section controls,
  and playback controls visible. The automated journey uploads the same fixture
  in a fresh browser context.
- Visible actions and states:
  1. Observe the rendered `The Wonderful Wizard of Oz` book content and desktop
     settings control.
  2. Activate `Play` and observe the control change to `Pause`.
  3. Narrow the actual browser viewport to 600 by 800 pixels.
  4. Observe that the control returns to `Play`, the same book title remains
     visible, and the mobile `Menu` replaces the desktop settings controls.
  5. Open `Menu` and observe the visible Zoom / Padding, Export Audiobook, and
     Settings actions.
  6. Widen the viewport to 1280 by 900 pixels and observe the desktop settings
     control, stopped playback, and readable book content again.
- Product accessibility defect found during three-browser acceptance and
  corrected: the Settings icon's internal filename-like SVG title leaked into
  the mobile menu item's accessible name, so assistive technology announced
  `file-settings-solid Settings`. The icon is now decorative within both
  explicitly labelled settings controls, leaving the mobile action named
  `Settings` and the desktop button named `Open settings`.
- The existing resize behavior itself was correct: it stopped active playback,
  kept the EPUB rendition readable, and exposed the reader actions in the
  mobile menu.
- Initial test scheduling: `epub-responsive.spec.ts` belonged to the dependent
  playback project group because it started real playback before resizing.
- Initial focused acceptance: `epub-responsive.spec.ts` passed concurrently in
  Chromium, Firefox, and WebKit as three cases in 7.7 seconds after the
  accessibility correction.
- Full-load follow-up: the first 42-case matrix exposed an existing upload
  dialog exit defect in one Chromium playback journey. The dialog was visibly
  transparent after its automatic close, but its Headless UI portal remained
  in the accessibility tree and its sidebar intercepted document clicks until
  the test timed out. The shared modal frame now disables pointer events for
  the complete closing portal immediately while retaining its exit animation;
  its backdrop and panel also remain pointer-transparent at the end of their
  leave transitions.
- Regression acceptance: the previously failing Chromium per-document playback
  journey passed in 17.7 seconds after the modal fix. The complete matrix then
  passed all 42 cases in 1.4 minutes with the configured seven-worker (`50%`)
  cap: all 33 core cases completed before the nine playback-dependent cases
  ran across Chromium, Firefox, and WebKit.
- Repository verification: `pnpm test` passed 112 Vitest files and 559 tests;
  `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, and `git diff --check`
  all passed.
- Playback-suite consolidation: after the three browser-observed playback
  journeys were accepted independently, their assertions were merged into
  `playback-controls.spec.ts`. The TXT portion owns voice/speed changes and
  reload persistence, while the existing EPUB start now owns the responsive
  stop and mobile-menu assertions. The standalone `playback-settings.spec.ts`
  and `epub-responsive.spec.ts` files were removed without dropping a visible
  contract or a supported document format.
- Final scheduling: only `playback-controls.spec.ts` matches the dependent
  playback projects. The suite therefore contains exactly one true playback
  case in Chromium, Firefox, and WebKit: 33 core cases followed by three
  playback cases, with `fullyParallel` retained and workers capped at `50%`.
- Consolidated acceptance: the three playback cases passed together in 1.1
  minutes. The complete reduced matrix passed all 36 cases in 1.8 minutes.
- CI boundary: the three consolidated playback cases require a real external
  TTS provider and are intentionally local-only. When `CI` is set, Playwright
  does not create the playback projects at all, so the core projects continue
  to ignore `playback-controls.spec.ts` and GitHub collects exactly the 33
  deterministic cases. The GitHub workflow no longer receives a provider API
  secret. Local `pnpm test:e2e` continues to collect all 36 cases.
- CI-mode diagnostic: the first local `CI=true` run collected only the expected
  33 core cases. One WebKit PDF-responsive attempt raced the highlight overlay
  repaint between its visible-state assertion and geometry read, then passed
  on the configured retry. The journey remains in CI; its geometry assertion
  now retries the complete visible bounding-box contract through the real
  repaint window instead of treating one transient detached overlay as the
  final state.
- Product-versus-test audit: the PDF viewer already keeps the page in its
  rendering state until the replacement canvas and text layer report ready,
  then clears and rebuilds the sentence overlay for the new geometry. Keeping
  the old overlay would expose visibly incorrect coordinates during resizing,
  so no product change was made for this normal repaint boundary.
- CI acceptance: five concurrent WebKit repetitions of the corrected responsive
  journey passed in 34.4 seconds. A subsequent full `CI=true` matrix collected
  and passed all 33 deterministic cases in 1.2 minutes with no retry and no
  playback project.
- Vitest ownership: rendition resize calculations, placement restoration, and
  playback state transitions remain deterministic tests. Playwright owns the
  user-visible layout change, stopped control state, usable menu, and readable
  book surface.

### Walkthrough 15: Operate Settings by keyboard and preserve a direct reader route

Observed with computer use on 2026-08-18 against the production build at
`http://localhost:3003`, then accepted through the same existing journeys in
Chromium, Firefox, and WebKit.

- Purpose: cover the remaining anonymous accessibility and routing contracts
  without creating a duplicate accessibility spec or a shallow route-only
  test.
- Initial state: an onboarded anonymous library with
  `multilingual-sample.txt` available. The canonical entry test reaches an
  empty library through the complete public first-run flow; the text journey
  uploads its own fixture in an isolated browser context.
- Visible keyboard and dialog actions:
  1. Move focus to the sidebar button named `Settings` and activate it with
     Enter.
  2. Observe the Settings panel, the labelled `Appearance` and `Documents`
     section controls, and keyboard focus inside the dialog.
  3. Press Escape, observe the panel leave the page, and require focus to
     return to the `Settings` trigger.
- Visible routing actions:
  1. Open the exact `multilingual-sample.txt` library link and observe its
     `/html/<document-id>` route, title, literal text, and playback-position
     control.
  2. Reload that direct reader URL and require the URL, title, readable text,
     and playback-position control to remain available.
  3. Activate `Back to documents` and observe the `/app` library before opening
     the Markdown document already owned by the same journey.
- Browser-authoring finding: Headless UI's outer dialog element intentionally
  has no visual box even while its panel is open. The visible contract is the
  Settings panel and its labelled controls; the dialog element remains the
  correct focus owner. The first focused run incorrectly asked the outer
  wrapper to be visible, and the accepted assertion was corrected without a
  product change.
- Load finding: one WebKit diagnostic remained visibly on `Starting anonymous
  session...` beyond the default five-second assertion while the local compute
  queue was draining. The canonical first-entry journey now gives that real
  startup state a bounded 30-second readiness budget inside a 45-second test;
  it still requires the Privacy dialog and complete first-run flow.
- No product defect remained after the assertion boundary was corrected. The
  native Settings button opened from Enter in all three Playwright browsers,
  Escape restored focus, the direct text route survived reload, and the back
  link returned to the library.
- Focused acceptance: the two owning specs ran as six concurrent cases across
  Chromium, Firefox, and WebKit; all six passed in 20.3 seconds. No new test
  case, helper, test id, retry, worker reduction, or serialized project was
  added.
- Matrix acceptance: the clean `CI=true` run collected and passed all 33
  deterministic cases in 1.2 minutes with seven workers and no playback
  project. The complete local run then passed all 36 cases in 1.9 minutes,
  including exactly one consolidated true-playback case in Chromium, Firefox,
  and WebKit.
- Repository verification: `pnpm test` passed 112 Vitest files and 559 tests;
  `pnpm exec tsc --noEmit`, `pnpm lint`, the production build started by each
  full Playwright run, and `git diff --check` all passed.
- Vitest ownership: focus-trap primitives, route authorization policy,
  anonymous-session persistence, and reader-state reducers remain
  deterministic non-browser concerns. Playwright owns the visible keyboard,
  dialog, reload, readable-content, and return-navigation result.

Do not create provider-specific playback tests until the required provider is
available and the journey succeeds with computer use in that environment.

Gate:

- UI actions match the computer-use walkthroughs;
- persistence is proven by a visible reload result;
- playback control state and actual playback progress are separate assertions;
- accessibility assertions are attached to real journeys rather than a second
  duplicate suite.

## Phase 5: Introduce Only Proven Shared Support

Status: complete.

Review accepted tests for genuine repetition. A small fixture or helper may be
extracted only when:

1. at least two accepted tests perform the same action;
2. the action has the same preconditions and result in both tests;
3. extraction does not hide the journey's meaningful assertion;
4. failures can still identify the last visible state.

Likely small owners, if the rebuilt suite proves they are needed:

```text
browser-tests/
  support/
    fixture.ts      # isolated browser context and explicit onboarding only
    upload.ts       # one upload action, no downstream reader assertion
    diagnostics.ts  # visible state, route, console, and request evidence
```

There is no planned replacement for the old `tests/helpers.ts`. Shared reader,
playback, and navigation abstractions must earn their existence from repeated
new code.

### Phase 5 acceptance evidence

- `tests/e2e/support/onboarding.ts` owns only the repeated visible path from a
  fresh anonymous `/app` context to an interactable empty library. Nine setup
  consumers use it; `anonymous-entry.spec.ts` remains fully inline as the
  canonical owner of the onboarding journey and its meaningful assertions.
- `tests/e2e/support/upload.ts` owns only opening the visible library chooser
  and selecting caller-provided files. Eight journeys use it when upload is
  setup; `supported-upload.spec.ts` keeps the chooser and multiple-file
  assertions inline because upload is that test's primary behavior.
- Neither helper injects storage, cookies, sessions, API state, reader state, or
  downstream assertions. Failures still identify the last visible action.
- Reader navigation, playback, document readiness, conversion, deletion, and
  PDF interaction remain readable in their owning specs rather than moving
  into a replacement monolithic helper.

## Phase 6: Parallel Browser Matrix and CI

Status: in progress; the deterministic three-browser CI boundary and local
artifact configuration are audited, while an actual GitHub run of the current
uncommitted suite remains pending.

1. Keep Chromium as the computer-use authoring and first diagnostic browser.
2. Run every deterministic accepted test in Chromium, Firefox, and WebKit in
   CI. Keep the three real-generation playback cases local-only until CI has a
   deliberately provisioned provider environment.
3. Set the suite and projects to full parallel execution with
   `workers: '50%'`; do not raise the cap to 100%.
4. Verify that separate browser projects actively overlap in time during a full
   run; a configured matrix that executes sequentially does not satisfy this
   requirement.
5. Treat collisions between browsers, users, sessions, documents, workers, or
   storage prefixes as application or isolation defects, not reasons to reduce
   concurrency.
6. Permit a browser-specific exclusion only for an externally imposed engine
   limitation, with an explicit documented reason and user approval. Permit an
   environment-specific exclusion only at project collection for a documented
   external dependency; currently this applies only to real TTS generation in
   CI.
7. Add CI with explicit Vitest and fully parallel replacement-browser jobs.
8. Publish one run-attempt-specific artifact bundle whose internal Playwright
   paths retain browser project, test, retry, and repeat identity so parallel
   failures cannot overwrite each other.

### Phase 6 audit evidence

- `.github/workflows/vitest.yml` independently runs `pnpm test:unit`; the
  Playwright workflow is therefore not responsible for duplicating Vitest.
- `.github/workflows/playwright.yml` builds the app, enforces the bundle guard,
  installs LibreOffice, FFmpeg, SeaweedFS, NATS, and all three Playwright
  browsers, then runs `pnpm test:e2e` with GitHub's `CI` environment. The
  Playwright config consequently collects exactly the 33 deterministic cases
  and creates no provider-dependent playback project. Pushes to `main` or
  `master` and pull requests targeting those branches run automatically;
  `workflow_dispatch` permits an explicit run for an unmerged feature branch
  without making every feature-branch push start the expensive browser job.
- The workflow uploads `playwright-report/` and `tests/results/` even on
  failure. Its artifact name now includes `github.run_id` and
  `github.run_attempt`, and missing diagnostics fail the upload step. Internal
  Playwright result paths retain the test and browser-project identity plus
  retry/repeat suffixes.
- The latest remotely visible historical Playwright run audited on 2026-08-18
  was GitHub Actions run `28686427606` for main commit `e9b4ac8b...`; it
  succeeded and uploaded a 2,489,058-byte `playwright-report` artifact. That
  artifact expired normally after its configured 30-day retention.
- Historical success proves the upload mechanism has worked, but it does not
  validate the current uncommitted replacement suite or the new artifact name.
  The Phase 6 external gate remains open until these changes are committed,
  pushed, and observed in their own GitHub Actions run.

## Phase 7: Final Coverage Audit

Status: in progress; the static inventory is complete, with two authenticated
routing decisions still explicitly deferred.

1. Compare the accepted replacement journeys with the inventory in this plan.
2. Confirm that every old scenario is replaced, merged, assigned to Vitest, or
   intentionally dropped.
3. Confirm there is no old Playwright code or compatibility helper left in the
   repository.
4. Run the full Vitest suite.
5. Run the complete replacement browser suite.
6. Run type checking, linting, and build checks required by the repository.
7. Record final scenario counts, browser assignments, and validation commands.

### Phase 7 audit evidence

- The seven deleted browser specs contained 35 named test cases at the reset
  boundary: 4 accessibility, 1 deletion, 2 folder, 4 landing/routing, 4 reader
  navigation, 7 playback, and 13 upload/reader cases.
- Thirty-three of those cases are now replaced or merged into the accepted
  visible journeys, assigned to deterministic Vitest owners, or intentionally
  dropped as redundant combined coverage. The folder-hint persistence row was
  the only gap found during this audit and is now merged into the accepted
  folder journey.
- Two old cases remain deferred rather than silently dropped: authenticated
  `/` redirecting to `/app`, and protected routes redirecting to sign-in when
  anonymous sessions are disabled. They require a controlled authenticated
  browser state and an explicit non-anonymous deployment mode respectively.
- No deleted spec, monolithic helper, global teardown, request namespace
  header, namespace feature flag, or namespace-triggered TTS mock remains in
  active source or test code. References under `docs-site/versioned_docs/` are
  immutable historical documentation snapshots, not live application wiring.
- Current assignment is 11 deterministic spec files across Chromium, Firefox,
  and WebKit (33 CI cases), plus one consolidated provider-dependent spec with
  one case in each browser (3 local-only cases), for 36 local cases total.
- Final local validation so far: the latest CI-mode matrix passed 33/33 in 1.1
  minutes after the folder-hint addition; the complete local matrix passed
  36/36 in 1.9 minutes. Vitest passed 112 files and 559 tests, along with
  TypeScript, lint, production build, and diff hygiene. The updated folder
  journey additionally passed 3/3 in its focused matrix.

---

## Phase Status

| Phase | Work | Status |
|---:|---|---|
| 0 | Record replacement inventory | Complete |
| 1 | Remove old Playwright tests; retain the empty harness | Complete |
| 2 | Computer-use walkthrough and first replacement test | Complete |
| 3 | Rebuild core reading journeys | Complete: priorities 1–7 accepted |
| 4 | Rebuild interaction journeys | Complete for the accepted anonymous scope: deletion, playback, voice/speed persistence, PDF navigation, responsive PDF and EPUB behavior, folder persistence, keyboard/dialog access, and direct-reader routing accepted; authenticated routing deferred pending controlled auth |
| 5 | Extract only proven shared support | Complete: onboarding and library upload only |
| 6 | Enforce the parallel three-browser matrix and CI | In progress: deterministic boundary, artifact configuration, and historical remote artifact audited; current GitHub run pending commit/push |
| 7 | Final coverage audit | In progress: 33 of 35 deleted cases resolved; two authenticated-routing cases remain explicitly deferred |

## Definition of Done

The replacement is complete when:

1. The former Playwright specs, helpers, teardown, fixtures, and test-only
   application scaffolding are gone while the clean harness remains.
2. There was a verified checkpoint where only Vitest test cases remained.
3. Every new browser test has a preceding computer-use walkthrough record.
4. New tests reproduce user actions through the visible interface.
5. No new test was copied or structurally translated from an old spec.
6. Backend and pure-state behavior has a deterministic Vitest owner.
7. Browser assertions describe visible behavior and actionable failure states.
8. Shared helpers exist only for repeated, narrow, proven contracts.
9. Every replacement test passes independently in Chromium, Firefox, and
   WebKit.
10. All three browser projects run concurrently within the intentional 50%
    worker cap and with isolated state.
11. The full Vitest and deterministic parallel replacement browser suites pass
    in CI; provider-dependent local journeys pass in every supported browser.
12. The final coverage audit accounts for every old scenario without requiring
    the old suite to remain in the repository.
