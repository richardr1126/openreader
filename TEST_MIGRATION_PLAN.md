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

1. Public landing and anonymous protected-route behavior.
2. Application entry/onboarding until the library is interactable.
3. Upload supported documents and observe them in the library.
4. Reject an unsupported upload with useful visible feedback.
5. Open and visibly read a PDF.
6. Open and visibly read an EPUB.
7. Open TXT and Markdown and observe their meaningful rendering difference.
8. Upload DOCX, observe conversion to PDF, and open it.
9. Navigate PDF view modes and pages.
10. Create a folder with drag-and-drop and verify persistence after reload.
11. Delete a document through the confirmation dialog.
12. Start and pause playback, including visible state and keyboard access.
13. Change voice and speed, then resume playback.
14. Verify responsive behavior that materially changes PDF or EPUB interaction.
15. Verify authenticated routing when a controlled authenticated state is
    available.

---

## Phase 2: Create the First Replacement Browser Test

Status: pending; begins only after the Phase 1 clean checkpoint.

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

## Phase 3: Rebuild Core Reading Journeys

Status: pending.

Walk through and then create tests for:

- application entry and library readiness;
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
| 2 | Computer-use walkthrough and first replacement test | Pending |
| 3 | Rebuild core reading journeys | Pending |
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
