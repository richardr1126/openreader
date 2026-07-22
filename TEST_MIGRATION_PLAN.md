# Test Migration Plan

## Goals

1. Make failures identify the boundary that actually broke.
2. Move backend lifecycle behavior out of browser tests when a closer test layer
   can cover it more deterministically.
3. Keep Playwright focused on browser-visible behavior and essential full-stack
   smoke coverage.
4. Simplify the test support layer instead of accumulating compatibility
   helpers for historical UI states.
5. Finish with a green suite that is already the intended long-term suite.
6. Preserve meaningful behavior while removing obsolete, duplicated, or
   misleading assertions.

## Non-Goals

- Do not make every existing test pass unchanged before improving its design.
- Do not create a second complete E2E suite and maintain both indefinitely.
- Do not preserve a Playwright test when its contract belongs to a unit or
  integration test.
- Do not treat longer timeouts as a general solution to missing observability.
- Do not run the complete cross-browser suite after every edit.
- Do not combine unrelated test domains into one unreviewable change.

---

## Core Migration Rule

Work one domain at a time. Changes may be substantial within that domain, but
the phase must not simultaneously redesign unrelated helpers, application
behavior, assertions, and execution policy elsewhere.

Examples of valid domain-scoped work:

- rewriting upload actions and assertions while fixing DOCX finalization;
- consolidating reader readiness while fixing an EPUB render/plan race;
- replacing playback-state helpers while correcting playback behavior.

Examples of invalid mixed work:

- changing uploads, reader readiness, playback assertions, folder timing, and
  serial execution in the same batch;
- strengthening every playback test while also changing the playback model;
- removing broad failure-cascade behavior before the affected tests are
  individually understood.

---

## The Execution Loop Within Every Phase

Every domain phase follows this loop:

```text
Inspect the existing failures and traces
        ↓
Choose the final owner for each behavior
        ↓
Rewrite or move the tests for that domain
        ↓
Fix actual product defects in that domain
        ↓
Run one representative test in one browser
        ↓
Inspect the result and correct the implementation
        ↓
Run the complete domain spec
        ↓
Run the domain in every browser that materially matters
        ↓
Record the ownership decisions and finish the phase green
```

The representative test is a diagnostic tool, not the final validation. The
domain spec is the primary phase gate. Cross-browser execution happens after
the domain passes in the first browser.

If the representative test fails, do not immediately run the full suite. Read
its trace, screenshot, requests, console output, and current application state.
Change one causal boundary, then rerun the same test.

If a phase reveals a failure owned by another domain, record it and defer it
unless it blocks the current domain. Do not expand the phase casually.

---

## Test Ownership Decision

Each existing logical scenario receives one of four decisions:

| Decision | Meaning |
|---|---|
| Keep | The test already belongs at its current layer and needs little or no redesign |
| Rewrite | The browser-visible contract is valuable, but the setup, helpers, or assertions are misleading |
| Move | The behavior belongs in a unit or integration test; retain only a smaller browser smoke contract if needed |
| Delete | The behavior is obsolete, duplicated, or an implementation detail with no useful contract |

Moving or deleting a test is not weakening coverage when its meaningful
contract has a clearer final owner. The ownership decision must be documented
before the old assertion disappears.

### Appropriate ownership by layer

Unit tests should own:

- reader load-state derivation;
- plan and locator selection;
- retry/backoff policy as pure logic;
- state transitions and formatting;
- deterministic error normalization.

Integration tests should own:

- upload preparation and finalization;
- DOCX `202` to completed-PDF lifecycle;
- worker operation creation and resolution;
- authoritative plan creation and retrieval;
- cancellation, retry, timeout, and explicit backend failure;
- route/client protocol contracts.

Playwright should own:

- the application becomes interactable;
- a supported upload appears in the library;
- a user can open each supported reader;
- the reader visibly reaches ready or exposes an actionable error;
- essential PDF and EPUB browser interaction;
- playback controls expose the correct user-visible state;
- important accessibility and routing behavior;
- a small number of deliberate full-stack smoke journeys.

---

## Final Test Support Design

The monolithic `tests/helpers.ts` should evolve toward explicit support owners:

```text
tests/support/
  fixture.ts       # namespace, session, navigation, onboarding
  actions.ts       # upload, open, play, pause, navigate
  readers.ts       # reader readiness and reader failure diagnostics
  playback.ts      # playback-specific observations and assertions
  diagnostics.ts   # phase, URL, network, console, and visible-state evidence
```

Migration into this structure happens only as a domain is processed. Do not
move every helper mechanically before its contract is understood.

### Helper rules

- Action helpers perform one user action and return useful handles or results.
- Action helpers do not silently assert unrelated downstream outcomes.
- Assertion helpers describe one product contract in their name.
- Negative scenarios must be able to use actions without inheriting positive
  assertions.
- Reader readiness must distinguish loading, ready, explicit error, render
  failure, and timeout.
- Playback started, playback progressed, and playback paused are separate
  contracts.
- CSS implementation details are not readiness signals when a stable product
  state or test identifier exists.
- A timeout failure must report the last observed domain state.

---

## Artifact and Run Policy

### Baseline

Start with one clean full run from the current source. Existing results created
from reverted code are evidence about that reverted experiment, not a valid
baseline for the current worktree.

The baseline must use alternate output paths so it does not unintentionally
replace an accepted canonical report:

```bash
PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/openreader-test-baseline-report \
pnpm exec playwright test \
  --output=/tmp/openreader-test-baseline-results
```

Record logical scenarios separately from per-browser executions. A single
scenario failing in three projects is one failure family with three browser
observations, not automatically three unrelated defects.

### Focused runs

During a phase, use unique temporary artifact paths for every diagnostic run.
Run in this order:

1. exact representative test in one browser;
2. complete domain spec in that browser;
3. domain spec in relevant additional browsers;
4. related-domain checks only when the changed boundary is shared.

### Full runs

Run the entire suite only:

- once to establish the clean baseline;
- when a cross-domain support boundary changes;
- at major phase checkpoints when the affected domains are green;
- for final acceptance.

Replace the canonical report only after a run is intentionally accepted.

---

## Phase 0: Clean Baseline and Contract Inventory

Status: pending.

1. Confirm the worktree and source revision.
2. Preserve or separately identify reports generated from reverted code.
3. Run the clean suite once into alternate artifact directories.
4. Group failures by logical scenario, symptom, and responsible boundary.
5. Create the Keep/Rewrite/Move/Delete inventory.
6. Select the representative test and first browser for every domain.

Gate:

- every failure belongs to a named family or is explicitly marked unknown;
- no implementation changes have been made from an unclassified timeout;
- the initial ownership inventory exists.

## Phase 1: Upload and Conversion

Status: pending.

Scope:

- supported and unsupported upload actions;
- document appearance in the library;
- duplicate/canonical identity behavior;
- DOCX asynchronous conversion;
- opening the converted PDF;
- upload error presentation.

Expected ownership changes:

- move detailed `202` conversion lifecycle, retry, cancellation, and failure
  behavior to integration tests;
- retain one Playwright DOCX smoke journey proving the converted PDF appears
  and opens;
- ensure unsupported uploads can use the upload action without inheriting a
  positive document-listed assertion.

Gate:

- upload and conversion integration tests pass;
- the upload Playwright spec passes in its primary browser;
- upload scenarios pass in every browser where upload behavior is materially
  different;
- upload support code has final ownership and no obsolete compatibility path.

## Phase 2: Reader Loading and Document Opening

Status: pending.

Scope:

- PDF, EPUB, and HTML reader navigation;
- shared reader preparation phases;
- source, parse, plan, and viewer readiness;
- reader retry and error presentation;
- first rendered position.

Expected ownership changes:

- keep load-state derivation in unit tests;
- keep worker/plan lifecycle protocol in integration tests;
- keep one explicit browser-visible readiness contract per reader type;
- replace container-only and generic network-idle waits with reader-domain
  observations that report the last preparation phase.

Gate:

- reader state and protocol tests pass;
- each reader opens successfully in the primary browser;
- PDF and EPUB pass in browsers with meaningful rendering differences;
- failures identify source, parse, plan, render, or timeout rather than only
  reporting a generic `loading` value.

## Phase 3: Playback

Status: pending.

Scope:

- Play and Pause controls;
- processing and buffering presentation;
- actual progress where the scenario promises audio playback;
- skip behavior;
- voice and speed changes;
- playback-driven highlights and reader navigation.

Expected ownership changes:

- test plan/segment selection and playback state logic below the browser layer;
- use Playwright for visible controls and a small number of real playback smoke
  journeys;
- do not use skip-button enabled state as a generic processing boundary;
- do not require real audio progress in accessibility tests that only promise
  labels and focus behavior;
- assert progress only where actual playback is part of the named contract.

Gate:

- playback logic tests pass;
- the primary Play/Pause journey passes in one browser;
- browser-specific media journeys pass where meaningful;
- navigation and highlighting scenarios pass without depending on unrelated
  control state.

## Phase 4: Library, Folders, Routing, and Accessibility

Status: pending.

Scope:

- document-list presentation and deletion;
- folder creation, movement, filtering, and persistence;
- landing and protected-route behavior;
- dialogs, labels, focus, and keyboard interaction.

Expected ownership changes:

- use domain-visible persistence results instead of generic network-idle waits;
- keep accessibility tests focused on semantics and interaction;
- remove duplicated cross-browser coverage where browser behavior is not
  materially different.

Gate:

- each UI domain passes in its primary browser;
- cross-browser cases are intentional rather than automatic duplication;
- no helper from another domain determines these tests' success.

## Phase 5: Execution and Coverage Audit

Status: pending.

This phase occurs only after all behavioral domains are green.

1. Review serial groups and shared-state assumptions.
2. Separate deterministic UI tests from deliberate real-worker smoke tests.
3. Assign browser coverage per scenario based on actual browser risk.
4. Remove obsolete tests whose contracts already have final owners.
5. Remove unused legacy helpers and flatten accidental indirection.
6. Confirm that a single failure does not create misleading cascade skips unless
   a serial dependency is intentional and documented.

Gate:

- every retained scenario has a stated purpose and owner;
- every cross-browser duplication has a reason;
- execution modes reflect real state dependencies;
- there is no legacy suite waiting to be scrapped later.

## Phase 6: Full Acceptance

Status: pending.

1. Run the complete unit and integration suites.
2. Run the complete Playwright suite into temporary artifacts.
3. Investigate any cross-domain failures using the same ownership rules.
4. Run static checks and builds required by the repository validation ladder.
5. Intentionally accept the final Playwright report.
6. Update this plan with the final scenario counts, browser matrix, and
   validation evidence.

Gate:

- the final suite is green;
- failures are diagnostic at the responsible boundary;
- the tests in the repository are already the long-term suite;
- no follow-up scrapping or parallel replacement project is required.

---

## Phase Status

| Phase | Work | Status |
|---:|---|---|
| 0 | Clean baseline and contract inventory | Pending |
| 1 | Upload and conversion | Pending |
| 2 | Reader loading and document opening | Pending |
| 3 | Playback | Pending |
| 4 | Library, folders, routing, and accessibility | Pending |
| 5 | Execution and coverage audit | Pending |
| 6 | Full acceptance | Pending |

---

## Definition of Done

The migration is complete when:

1. Every meaningful behavior has one clear test owner.
2. Backend lifecycle correctness is not inferred only through browser timeouts.
3. Playwright tests assert browser-visible contracts rather than internal
   implementation transitions.
4. Test actions and assertions are separated enough that negative scenarios do
   not inherit positive expectations.
5. Reader failures report their last preparation phase and explicit error.
6. Playback tests distinguish control state from actual progress.
7. Browser coverage is intentional and proportional to browser-specific risk.
8. Obsolete and duplicated tests and helpers have been removed during their
   owning phase.
9. The full validation ladder passes.
10. The resulting suite requires no later scrap-and-rewrite phase.
