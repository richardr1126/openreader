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
| Dismiss folder hint and persist | Replace if still present | Observe current UI first; drop if obsolete |
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
13. Verify responsive behavior that materially changes PDF or EPUB interaction.
14. Verify authenticated routing when a controlled authenticated state is
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
| 6 | TXT and Markdown open with a meaningful visible rendering difference | One comparison journey only if the walkthrough shows a durable user-facing distinction | Text decoding, Markdown transformation, and HTML block rules remain in Vitest |
| 7 | DOCX visibly converts to PDF and the result opens | One conversion smoke journey | Conversion lifecycle, retries, finalization, and cleanup remain in Vitest |
| 8 | A user confirms deletion and the document disappears from the library | One dialog-and-library-update journey with keyboard/focus assertions | Blob cleanup, leases, and account ownership remain in Vitest |
| 9 | A user starts and pauses reading and sees both control and progress state | One primary-format playback journey with keyboard access | Provider protocol, segment planning, audio alignment, caching, and token contracts remain in Vitest |

The core gate does not require PDF view-mode depth, folder drag-and-drop,
responsive reader behavior, voice/speed customization, provider-specific
coverage, or authenticated routing. Those remain valuable follow-on journeys
in Phases 4 and 6 and must not be used to delay acceptance of the core suite.

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

Status: in progress; supported upload is accepted and the unsupported-input,
PDF-reader, and EPUB-reader walkthroughs are complete.

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

Walk through and then create tests for:

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

Status: pending.

Walk through and then create tests for:

- PDF page and view-mode navigation;
- folder drag-and-drop and persistence;
- deletion and confirmation behavior;
- playback start and pause;
- voice and speed changes;
- responsive PDF and EPUB behavior;
- keyboard, focus, labels, dialogs, and important routing behavior.

Do not create provider-specific playback tests until the required provider is
available and the journey succeeds with computer use in that environment.

Gate:

- UI actions match the computer-use walkthroughs;
- persistence is proven by a visible reload result;
- playback control state and actual playback progress are separate assertions;
- accessibility assertions are attached to real journeys rather than a second
  duplicate suite.

## Phase 5: Introduce Only Proven Shared Support

Status: pending.

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

## Phase 6: Parallel Browser Matrix and CI

Status: pending.

1. Keep Chromium as the computer-use authoring and first diagnostic browser.
2. Run every accepted test in Chromium, Firefox, and WebKit by default.
3. Set the suite and projects to full parallel execution with
   `workers: '50%'`; do not raise the cap to 100%.
4. Verify that separate browser projects actively overlap in time during a full
   run; a configured matrix that executes sequentially does not satisfy this
   requirement.
5. Treat collisions between browsers, users, sessions, documents, workers, or
   storage prefixes as application or isolation defects, not reasons to reduce
   concurrency.
6. Permit a browser-specific exclusion only for an externally imposed engine
   limitation, with an explicit documented reason and user approval.
7. Add CI with explicit Vitest and fully parallel replacement-browser jobs.
8. Publish artifacts with browser, test, retry, and worker identity so parallel
   failures cannot overwrite each other.

## Phase 7: Final Coverage Audit

Status: pending.

1. Compare the accepted replacement journeys with the inventory in this plan.
2. Confirm that every old scenario is replaced, merged, assigned to Vitest, or
   intentionally dropped.
3. Confirm there is no old Playwright code or compatibility helper left in the
   repository.
4. Run the full Vitest suite.
5. Run the complete replacement browser suite.
6. Run type checking, linting, and build checks required by the repository.
7. Record final scenario counts, browser assignments, and validation commands.

---

## Phase Status

| Phase | Work | Status |
|---:|---|---|
| 0 | Record replacement inventory | Complete |
| 1 | Remove old Playwright tests; retain the empty harness | Complete |
| 2 | Computer-use walkthrough and first replacement test | Complete |
| 3 | Rebuild core reading journeys | In progress: priorities 1–5 accepted |
| 4 | Rebuild interaction journeys | Pending |
| 5 | Extract only proven shared support | Pending |
| 6 | Enforce the parallel three-browser matrix and CI | Pending |
| 7 | Final coverage audit | Pending |

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
11. The full Vitest and fully parallel replacement browser suites pass in CI.
12. The final coverage audit accounts for every old scenario without requiring
    the old suite to remain in the repository.
