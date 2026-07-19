# Project Cleanup Plan

This is the living cleanup plan for the post-reinvention OpenReader codebase.
It complements `PLAYBACK_ARCHITECTURE.md`: that document defines the playback
and derived-media architecture, while this document tracks repository-wide
dead-path removal, module-boundary cleanup, and decomposition of large files.

The branch is intentionally treated as a new architecture rather than as a
small patch over `main`. Cleanup should preserve the new ownership model and
remove scaffolding that only made sense while the transition was in progress.

Implementation history and pending work live at the end of this document under
`Completed Work` and `Remaining Work`. The cleanup roadmap uses one canonical
counter: **Step 1** through **Step 8**. Baseline work that predates the roadmap
is intentionally unnumbered and does not consume a step number.

---

## Goals

1. Remove obsolete runtime routes, helpers, types, exports, compatibility
   surfaces, and tests that no longer serve the current architecture.
2. Keep route, job, and UI ownership obvious from the directory structure.
3. Break orchestration monoliths into cohesive domain modules without changing
   behavior or introducing parallel sources of truth.
4. Make future hard cuts complete: when a path is replaced, its callers,
   protocol surface, generated types, tests, and documentation should disappear
   together.
5. Leave the repository easier to navigate, test, and review before this branch
   becomes the basis for future feature work.

## Non-Goals

- Do not redesign playback behavior while performing structural extraction.
- Do not change storage layouts, operation identity, or public behavior merely
  to make files shorter.
- Do not count generated files, frozen versioned documentation, migration
  history, model code, or cohesive algorithm implementations as monolith debt
  based on line count alone.
- Do not fold the v4 decommission into this cleanup. The v4 decommission entry
  point, migration history, and its documented legacy-prefix knowledge are
  intentional exceptions.
- Do not remove a compatibility path until its release/removal condition is
  satisfied and documented.

---

## Core Rules

### Remove a path completely

When an endpoint or runtime path is retired, remove all of the following in the
same change:

- route implementation;
- request/response schema;
- app or worker protocol types;
- client method and all callers;
- OpenAPI entry and generated client surface;
- route-map and contract assertions;
- unit/E2E tests that only test the retired behavior;
- active documentation and environment/config references.

Negative regression assertions may remain when they protect an important hard
cut, but they should not pin an obsolete replacement route in place.

### Extract by ownership, not line count

A large file should be split when it contains multiple independently testable
responsibilities or multiple domain owners. A long algorithm may remain intact
when its state and invariants are cohesive.

Good extraction boundaries:

- one domain's route registration;
- one worker job kind;
- one lifecycle controller;
- one settings panel and its mutations;
- one persisted-state adapter;
- one storage/configuration concern.

Bad extraction boundaries:

- arbitrary line-count slices;
- thin wrapper files with no ownership or testing benefit;
- splitting state that must remain synchronized into separate React sources of
  truth;
- duplicating shared parsing, validation, or storage logic during extraction.

### Preserve the architecture during cleanup

- Next remains the authenticated control plane.
- The compute worker remains the heavy/long-running data plane.
- SQL remains app-owned except for the existing narrow, read-only worker access
  to provider credentials.
- Worker operation-key parsing belongs beside operation-key construction.
- Storage transport rules have one shared resolver.
- React providers should expose the smallest stable consumer-facing surface;
  implementation controllers belong in hooks or plain modules.

### Keep changes reviewable

- Separate verified dead-code deletion from structural extraction.
- Preserve behavior with tests before moving complex logic.
- Prefer small composition roots over new barrel files with broad implicit
  exports.
- Keep generated OpenAPI changes in the same commit as their source route or
  schema change.
- Avoid opportunistic styling or feature changes during structural work.
- Update the work-history section when a step lands so the document describes
  the repository as implemented, not only the original proposal.

---

## Target Structure

The target is not a file-count goal. It is a repository where directory and
module boundaries communicate ownership without requiring a reader to inspect
multi-thousand-line composition files.

### Compute worker API

The worker API should have a small composition root and domain-owned route
registrars. Playback read-model, sidecar-cache, audio-range, and invalidation
logic should not all live inside one registration closure.

Implemented in Step 2:

```text
packages/compute-worker/src/api/
  routes.ts                         # small composition root
  route-context.ts                  # shared dependency types only
  routes/
    health.ts
    operations.ts
    document-jobs.ts
    account-exports.ts
    cleanup.ts
    playback/
      sessions.ts
      exports.ts
      audio.ts
  playback/
    session-read-model.ts
    session-controller.ts
    operation-invalidation.ts
```

Sidecar and parsed-plan caching remain intentionally owned by
`session-read-model.ts`; they are not split into a thin cache wrapper.

### Compute worker jobs

Each worker job kind should own its request parsing and implementation.
`createJobHandlers` should compose those implementations rather than contain
them.

Implemented in Step 3:

```text
packages/compute-worker/src/jobs/
  handlers.ts                       # JobHandlers interface + composition
  context.ts                        # shared handler dependencies only
  pdf-layout.ts
  document-preview.ts
  document-conversion.ts
  account-export.ts
  playback/
    schemas.ts
    plan.ts                         # source derivation + canonical plan persistence
    segment-generation.ts          # synthesis, retry, leases, sidecars
    playback-job.ts                # live generation pacing
    plan-job.ts
    export-job.ts
    ffmpeg-export.ts
```

### Client playback

`TTSContext` should remain the public reader/player integration facade, but it
should not implement every playback, plan, export, navigation, and browser-audio
lifecycle itself.

Implemented in Step 4:

```text
src/contexts/TTSContext.tsx             # public facade and composition only
src/hooks/audio/
  useTtsPlayback.ts                     # high-level playback controller
  usePlaybackProjection.ts              # time -> segment/word/location
  usePlaybackForegroundSync.ts          # SSE/timeline/cursor heartbeat
  useTtsPlanController.ts               # plan creation/application
  useTtsDocumentExport.ts               # resolve/start export artifact flow
  useTtsDocumentNavigation.ts           # reader anchors, navigation, and auto-resume
  useTtsPlaybackSettings.ts             # settings-driven restart/invalidation
src/lib/client/tts/
  playback-selection.ts                 # pure anchor -> canonical selection rules
```

The audio element, seek/resync state, and session transport remain together in
`useTtsPlayback.ts` because separating them would require mirrored mutable refs
or a second state machine.

### Settings

Settings navigation and modal composition should be separate from section
business logic and long-lived mutations.

Implemented in Step 5:

```text
src/components/SettingsModal.tsx               # compatibility re-export
src/components/settings/
  SettingsModal.tsx                            # navigation + composition
  ProviderSettingsPanel.tsx
  AppearanceSettingsPanel.tsx
  DocumentSettingsPanel.tsx
  AccountSettingsPanel.tsx
  AdminSettingsPanel.tsx
  SettingsChangelogPanel.tsx
  useLibraryImport.ts
  useAccountExport.ts
```

Admin panels already have their own component boundary and should remain there.

### Document list

The Finder-style presentation should consume a controller instead of owning
preference persistence, query derivation, mutations, DnD actions, upload state,
dialogs, and rendering in one component.

Implemented in Step 6:

```text
src/components/doclist/
  DocumentList.tsx                    # providers + shell composition
  useDocumentListController.ts        # derived data and user actions
  document-list-preferences.ts        # normalize/serialize current shape
  document-list-model.ts              # pure folder/filter/sort/status derivation
  SidebarUploadLoader.tsx
```

Existing view, sidebar, toolbar, status bar, DnD, and selection components
should remain separate rather than being rewrapped.

### Shared runtime configuration

Storage transport resolution should be an explicit shared package or module,
not source imported through the bootstrap package's internal directory.
Step 7 also owns a repository-wide environment-variable sweep so configuration
code, templates, local development files, deployment examples, and active docs
describe one current contract.

Conceptual target:

```text
packages/runtime-config/
  package.json
  src/storage-transport.ts
```

Bootstrap may layer environment mutation and startup behavior over the pure
resolver. Next and the worker should consume the same exported resolution
contract without depending on bootstrap internals.

---

## Audit Baseline

The initial audit was run on `refactor/playback-streams` after the route and
storage hard cuts.

Large source files at the audit baseline, excluding generated code:

| File | Lines | Initial classification |
|---|---:|---|
| `packages/compute-worker/src/api/routes.ts` | 2,196 | Split by route domain and playback read model |
| `packages/compute-worker/src/jobs/handlers.ts` | 1,950 | Split by worker job kind |
| `src/contexts/TTSContext.tsx` | 1,698 | Thin provider facade over cohesive controllers |
| `src/components/SettingsModal.tsx` | 1,357 | Split by settings section and mutation ownership |
| `src/hooks/audio/useTtsPlayback.ts` | 995 | Split audio, projection, sync, and seek lifecycles |
| `packages/compute-worker/src/inference/whisper/align.ts` | 926 | Review, but keep intact if algorithm remains cohesive |
| `packages/tts/src/generate.ts` | 919 | Review provider boundaries; do not split mechanically |
| `src/components/doclist/DocumentList.tsx` | 832 | Extract controller/state persistence from rendering |
| `src/lib/client/pdf.ts` | 741 | Review worker setup vs highlight DOM ownership |
| `src/lib/client/api/documents.ts` | 678 | Split only if domain API groups remain cohesive |
| `src/lib/client/api/tts.ts` | 479 | Keep under observation; current domain surface is cohesive |

This table is an audit queue, not a requirement that every file fall under an
arbitrary limit.

The size baseline should be regenerated after the structural work. Every
remaining source file over roughly 600 lines should receive an explicit
keep/split decision based on ownership and cohesion.

## Current State Snapshot

This snapshot was verified against the working tree on 2026-07-18 and reflects
the repository after Steps 1 through 6:

| Roadmap owner | Current state | Next action |
|---|---|---|
| Compute worker routes | `api/routes.ts` is a 46-line composition root over domain registrars; playback read-model, session-controller, and invalidation ownership are extracted | Complete in Step 2 |
| Compute worker jobs | `jobs/handlers.ts` is a 51-line exhaustive composition root; each job kind owns parsing and implementation, while playback planning, segment generation, pacing, and FFmpeg export have explicit modules | Complete in Step 3 |
| Client playback | `TTSContext.tsx` is a 736-line facade/composition root; plan, export, projection, foreground sync, navigation, and settings-restart ownership are extracted; `useTtsPlayback.ts` is the single 754-line audio/session/seek controller | Complete in Step 4 |
| Settings | The public `SettingsModal.tsx` is a one-line compatibility export over a 195-line navigation/composition root; provider, appearance, documents, account, admin, changelog, import, and export ownership are extracted | Complete in Step 5 |
| Document list | `DocumentList.tsx` is a 269-line presentation/composition shell over an explicit controller; preferences and pure folder/filter/sort/status derivation have focused owners | Complete in Step 6 |
| Runtime configuration | Four runtime files and one test still import `packages/bootstrap/src/storage-transport.mjs` directly; the full environment-variable contract has not yet been reconciled | Step 7 (next) |
| Final audit | Deferred until the structural steps are complete | Step 8 |

The audit-baseline table above remains historical evidence; this snapshot is
the authoritative summary of current roadmap state.

Current verification:

- `pnpm test:unit` passed: 108 files, 571 tests;
- root and compute-worker TypeScript checks passed;
- compute-boundary and route-error checks passed;
- the production build passed;
- `git diff --check` passed.

---

## Compatibility Register

Do not delete a path merely because it contains words such as `legacy` or
`deprecated`. Every retained path should have a reason and a removal condition.

| Path | Owner and reason | Removal condition |
|---|---|---|
| v4 storage decommission and frozen migration/docs references | Bootstrap/decommission tooling; required to migrate v4 object layouts and preserve released documentation | Retain as migration history; it is explicitly outside this cleanup plan |
| `S3_ENDPOINT` alias and warning | Runtime storage configuration; lets v4 deployments move to explicit internal/public endpoints with a warning | Remove in OpenReader 5.0, together with active docs, examples, bootstrap handling, and tests |
| Safari/PDF.js legacy build selection | PDF client loader; Safari 18 and earlier still require the PDF.js legacy build | Remove after the supported Safari baseline no longer includes version 18 and standard-build PDF E2E coverage passes on the oldest supported Safari |
| provider preference normalization | User-preference normalization; converts stored built-in/sentinel selections to the current shared-provider model | Remove after a migration rewrites those stored values and the oldest supported database snapshot no longer contains them |
| legacy filesystem claim cleanup | User claim/data cleanup; active claims can still encounter pre-server-storage filesystem records | Remove when the supported upgrade floor excludes filesystem-backed user data and the claim migration is retired |
| browser `openreader-db` IndexedDB deletion | App provider startup; best-effort cleanup for clients predating server-backed state | Remove after the v4.4.0 release, which completes the documented full release cycle following v4.3.0 |
| non-EPUB TTS locator `location`/`page` fallbacks | Shared TTS locator identity; PDF and HTML plans still use these fields | Remove only after a versioned plan migration guarantees all supported persisted plans use replacement typed locator fields |

Avoid open-ended “just in case” compatibility. When a removal condition is met,
add the deletion to `Remaining Work` or record it under `Completed Work` when it
lands.

---

## Validation Ladder

Use validation proportional to each change, then run the complete ladder before
declaring the plan complete.

### Fast checks after each focused change

```bash
pnpm exec tsc --noEmit
pnpm check:compute-boundary
pnpm lint:route-errors
```

Run focused Vitest files for the domain being changed.

### Route and protocol changes

```bash
pnpm compute:openapi:generate
pnpm test:unit
```

Inspect the OpenAPI and generated-client diff in the same change. Use
`pnpm compute:openapi:check` in CI or from a clean working tree.

### Client and UI structural changes

```bash
pnpm test:unit
pnpm build
```

Run the highest-value Playwright paths for:

- upload and open PDF/EPUB/TXT/DOCX;
- playback start, pause/resume, seek, and document navigation;
- background/foreground playback recovery;
- document preview generation;
- audiobook MP3 and M4B export;
- account export;
- settings import/export/delete flows;
- folder creation, drag/drop, and document deletion.

External worker, object storage, NATS, model, and provider requirements should
be recorded when a full E2E path cannot run locally.

### Final clean-state validation

```bash
pnpm migrate
pnpm test:unit
pnpm exec tsc --noEmit
pnpm check:compute-boundary
pnpm lint:route-errors
pnpm compute:openapi:check
pnpm build
git diff --check
git status --short
```

The final status should contain only intentional cleanup changes before commit,
and should be clean after the cleanup series is committed.

---

## Completed Work

This section records baseline work that predates the roadmap and completed
roadmap steps. Detailed playback-specific history remains in
`PLAYBACK_ARCHITECTURE.md`; this list records the repository-cleanliness result
rather than duplicating that implementation narrative.

### Baseline: Initial Repository Cleanup Audit

Status: complete.

The branch was reviewed as a replacement architecture rather than as a narrow
diff from `main`.

Verified:

- Removed `/api/audiobook` callers and routes are absent.
- Removed TTS segment manifest/ensure paths are absent.
- Removed document blob upload/get/preview fallback routes are absent.
- The old `/api/documents/library` namespace is absent; local-library routes use
  `/api/local-library` explicitly.
- No `migrate-fs`, `openreader-migrate-storage`, or legacy audiobook runtime
  callers remain outside allowed historical/decommission material.
- Generated/build/test output is not tracked.
- The working tree was clean at the end of the audit.

Validation at the audit baseline:

- `pnpm exec tsc --noEmit` passed.
- `pnpm test:unit` passed: 97 files, 539 tests.
- `pnpm check:compute-boundary` passed.
- `pnpm lint:route-errors` passed.
- `pnpm build` passed with one unused-import warning in `TTSContext.tsx`, later
  removed in Step 1.

### Baseline: Playback and Storage Route Hard Cut

Status: complete before this plan.

The branch already removed the compatibility route families that would
otherwise have been the largest source of stale-path debt:

- the legacy audiobook API and client pipeline;
- TTS manifest, ensure, and fallback-audio routes;
- live-session Next audio byte proxying;
- document upload/get/preview fallback proxies;
- the old document-library route namespace;
- Next-side preview rendering, DOCX conversion, and audiobook packaging paths;
- old filesystem-to-S3 migration commands superseded by the v4 decommission.

Route-map and architecture tests protect the final hard-cut surface. Frozen
versioned docs, migration history, and the v4 decommission remain intentional
exceptions.

### Baseline: Shared Pre-Merge Cleanup Already Landed

Status: complete before this plan.

The playback branch already consolidated several cross-cutting helpers:

- operation-event SSE proxy plumbing;
- artifact download and filename sanitization behavior;
- worker storage prefix deletion and ownership helpers;
- export retention paths;
- operation reuse policy;
- playback reset-scope parsing for plan/export keys;
- worker-owned derived-artifact deletion.

Those improvements remain shared during the decompositions below. The direct
session-id parsing that remained in the old route monolith was removed in Step
2 and now uses the canonical operation-key parser.

### Step 1: Remove Verified Dead Runtime Surface

Status: complete.

Step 1 removed obsolete behavior before the structural decompositions:

- retired the unused playback cache-reset route, standalone schema, protocol
  result, client method, OpenAPI operation, and active architecture reference;
- kept cache clearing as the single invalidation path and added route-map
  assertions for epoch updates, session/job invalidation, sidecar eviction, and
  worker-owned artifact deletion;
- replaced the orphaned Next TTS segment blobstore with a test-owned generic S3
  prefix cleanup helper used only by Playwright teardown, then deleted the
  preservation-only blobstore tests;
- removed unused TTS context fields and ordinal-play helpers, the completed
  segment resolver, `CodeBlock`, `RateLimitIndicator`, and the `useRateLimit`
  alias;
- removed obsolete document-list folder fields from the current type, defaults,
  serialization, and server preference writes while retaining unknown-key
  tolerance for old stored JSON;
- assigned every retained compatibility path an owner, reason, and concrete
  release or data removal condition.

Validation:

- focused preference and architecture tests passed;
- the full unit suite passed: 96 files, 536 tests;
- TypeScript, compute-boundary, and route-error checks passed;
- generated OpenAPI and client types were refreshed;
- the production build passed without unused-variable warnings.

### Step 1 Checkpoint: Runtime Stabilization

Status: complete.

The runtime issues discovered while verifying the Step 1 baseline were fixed
before beginning structural extraction:

- the configured browser-proxy upload transport now accepts prepared `PUT`
  uploads, while the preparation endpoint remains `POST`-only;
- embedded SeaweedFS now advertises the configured reachable host instead of a
  stale auto-detected LAN address;
- live playback streams now begin at the selected canonical plan ordinal for
  EPUB, PDF, and HTML, while one shared stream-time offset preserves the
  whole-document timeline and scrubber;
- EPUB sentence and word highlights use a non-mutating DOM Range painter on the
  hot path, with epub.js CFI annotations retained only as a compatibility
  fallback;
- EPUB word highlights resolve the active application `--accent` value into the
  iframe rule, preserving the primary theme color at the existing opacity.

These are stabilization fixes, not a separate cleanup step. They establish the
behavioral baseline that Step 2 preserved while routes were moved.

Validation at this checkpoint:

- upload-route, embedded-storage, playback-layout, architecture, time-grid, and
  range-painter focused tests passed;
- the full unit suite passed: 99 files, 546 tests;
- TypeScript and the production build passed;
- OpenAPI and generated compute-worker client types were refreshed;
- `git diff --check` passed.

### Step 2: Decompose Compute Worker Routes

Status: complete.

After Step 1 and its stabilization checkpoint, Step 2 replaced the then-current
2,134-line worker route registrar with a 46-line composition root and
domain-owned registrars for health, operations/SSE, document jobs, account
exports, cleanup, playback sessions, playback exports, and live playback
audio. The earlier 2,196-line figure remains the original audit baseline.

Shared dependencies now have an explicit route-context contract instead of
being captured by one registration closure. Playback session reads, immutable
sidecar caching, cache-epoch handling, bounded sidecar scans, and parsed-plan
caching have one owner in `api/playback/session-read-model.ts`. Session writes
and continuation enqueueing live in `api/playback/session-controller.ts`.
Playback operation invalidation is isolated in
`api/playback/operation-invalidation.ts`, and live-session operation keys are
parsed only through `ttsPlaybackSubjectFromOperationKey`.

The live-audio registrar preserved ordinal-anchored starts, shared stream-time
offset behavior, whole-document seek layout, byte-range responses, scaffolding
silence, and generation re-anchoring. Route registration order was retained so
the regenerated OpenAPI document and generated client are byte-for-byte
unchanged by the structural extraction.

Focused tests cover completed-sidecar caching, missing-sidecar re-reads,
cache-epoch invalidation, scoped cache eviction, parsed-plan invalidation, and
operation invalidation through canonical key parsing. Architecture assertions
now discover domain registrar files and protect the small composition root.

Validation:

- the full unit suite passed: 102 files, 552 tests;
- root and compute-worker TypeScript checks passed;
- compute-boundary and route-error checks passed;
- OpenAPI and generated client output matched the pre-extraction snapshot
  byte-for-byte;
- the production build passed;
- `git diff --check` passed.

### Step 3: Decompose Worker Job Handlers

Status: complete.

The 1,950-line job-handler monolith is now a 51-line exhaustive composition
root. PDF layout, document preview, document conversion, account export, live
playback, playback planning, and playback export each own their request parsing
and implementation. A narrow `JobHandlerContext` makes shared dependencies
explicit without coupling job modules to API routes.

Playback plan schemas, source-unit derivation, segmentation signatures, and
canonical plan persistence live together under `jobs/playback/plan.ts` and
`schemas.ts`. Segment synthesis now owns provider resolution, bounded retries,
error classification, generation leases, cache-epoch checks, sidecar healing,
alignment, and content-addressed audio writes in
`segment-generation.ts`. Live cursor pacing and background-extent decisions
remain in `playback-job.ts`; audiobook assembly and FFmpeg details are isolated
in `export-job.ts` and `ffmpeg-export.ts`.

The worker-loop dispatch contract and timing/progress payloads are unchanged.
Existing plan/source derivation tests now import their domain owner directly,
and focused tests cover exhaustive handler composition, retry classification,
speed-adjusted export chapters, filenames/content types, and ID3 stripping.
Architecture assertions follow the extracted job modules instead of pinning
behavior to the old monolith.

Validation:

- the full unit suite passed: 103 files, 557 tests;
- root and compute-worker TypeScript checks passed;
- compute-boundary and route-error checks passed;
- the production build passed;
- `git diff --check` passed.

### Step 4: Simplify Client Playback State

Status: complete.

`TTSContext.tsx` is now a 736-line public facade and composition root, down
from 1,568 lines at the start of the step. Canonical plan creation,
ready-state loading, plan application, and plan preview ownership live in
`useTtsPlanController.ts`; document MP3/M4B resolution and start orchestration
live independently in `useTtsDocumentExport.ts`.

The live playback controller remains the sole owner of the
`HTMLAudioElement`, session transport, and seek/resync state. Its playhead
projection and timeline refresh loop moved to `usePlaybackProjection.ts`, and
SSE refresh plus cursor heartbeats moved to `usePlaybackForegroundSync.ts`.
This reduced `useTtsPlayback.ts` from 1,002 to 754 lines without introducing a
polling fallback or a second playback state machine.

Reader-anchor updates, PDF/HTML/EPUB navigation, blank-section handling,
pause/auto-resume intent, and skip behavior now have one owner in
`useTtsDocumentNavigation.ts`. Settings-driven audio restarts and plan/cache
invalidation live in `useTtsPlaybackSettings.ts`. Pure PDF, HTML, and EPUB
anchor-to-plan selection rules moved to `playback-selection.ts` with focused
tests, while `useTtsPlaybackModel.ts` remains the single canonical plan and
selected-ordinal model.

Architecture assertions now follow the extracted owners instead of pinning
all playback behavior to the context or live-audio file. The context's public
surface and reader integrations are unchanged.

Validation:

- the full unit suite passed: 104 files, 560 tests;
- focused playback-selection, reader-ownership, and server-state architecture
  tests passed;
- root and compute-worker TypeScript checks passed;
- compute-boundary and route-error checks passed;
- the production build passed without hook or unused-variable warnings;
- `git diff --check` passed.

### Step 5: Split Settings by Section

Status: complete.

The 1,357-line settings monolith is now a one-line public compatibility export
over a 195-line navigation and composition root. Provider selection and draft
state, appearance and custom-theme editing, document maintenance, account
actions, admin tabs, and changelog rendering each have a domain-owned panel
under `src/components/settings/`; no settings section imports another section.

Library import now has an explicit `useLibraryImport` lifecycle owner for
selection, progress, upload orchestration, cancellation, and unmount cleanup.
Account export similarly has a `useAccountExport` owner for artifact resolution,
SSE progress, download handoff, disconnection handling, and EventSource cleanup.
The panels remain mounted while users switch settings sections or inspect the
changelog, preserving in-progress form state and the previous cross-tab
behavior.

The existing responsive sidebar/modal layout, shared UI primitives, admin
panels, provider policy, theme presentation, import/export flows, account
actions, privacy entry point, and changelog presentation are unchanged.
Architecture assertions now follow the extracted account-export and form-control
owners and protect the small composition root, section independence, and
long-running lifecycle cleanup.

Validation:

- the full unit suite passed: 105 files, 563 tests;
- focused settings-architecture, shared-control, provider-view-model, and
  server-state architecture tests passed;
- root TypeScript, compute-boundary, and route-error checks passed;
- the production build passed;
- `git diff --check` passed.

### Step 6: Split Document List State from Presentation

Status: complete.

The 826-line document-list monolith is now a 269-line presentation and
composition shell over `useDocumentListController.ts`. The controller owns
local dialog, search, responsive-sidebar, upload-progress, and selection state,
while continuing to delegate document, folder, and preference mutations to the
existing `useDocuments`, `useFolders`, and `useUserPreferences` query owners.
No parallel document, folder, or preference state was introduced.

Preference defaults, the former `grid` migration, and current-shape
serialization live in `document-list-preferences.ts`; serialization tests
protect the removal of obsolete folder fields. Folder membership, stale-folder
handling, document unioning, sidebar and search filtering, sorting, recents,
counts, status summaries, and folder-name suggestions are pure and covered in
`document-list-model.ts`. The sidebar upload indicator also has its own small
presentation component.

The existing Finder window, toolbar, sidebar, status bar, views, DnD provider,
selection provider, upload surfaces, and dialogs remain the rendering owners.
Architecture assertions protect the small shell and prevent query/mutation
ownership from drifting back into it.

Validation:

- the full unit suite passed: 108 files, 571 tests;
- focused preference, model, and document-list architecture tests passed;
- root and compute-worker TypeScript checks passed;
- compute-boundary and route-error checks passed;
- the production build passed;
- `git diff --check` passed.

---

## Remaining Work

The steps below are the remaining implementation work. When a step lands, move
its detailed result into `Completed Work` and mark its status row complete.

### Step Status

| Step | Work | Status |
|---:|---|---|
| 1 | Remove verified dead runtime surface | Complete |
| 2 | Decompose compute worker routes | Complete |
| 3 | Decompose worker job handlers | Complete |
| 4 | Simplify client playback state | Complete |
| 5 | Split settings by section | Complete |
| 6 | Split document-list state from presentation | Complete |
| 7 | Establish shared runtime configuration boundary and sweep environment variables | Next |
| 8 | Final dead-code and boundary audit | Pending |

### Step 7: Establish a Shared Runtime Configuration Boundary and Sweep Environment Variables

Status: next.

Storage transport resolution currently lives in
`packages/bootstrap/src/storage-transport.mjs`, but the Next app and compute
worker import that bootstrap source directly. Bootstrap is therefore acting as
an undeclared shared library. This step must also perform a fresh inventory of
every environment-variable read on the branch rather than assuming the current
templates and documentation are complete.

Rules:

- inventory environment access across the Next app, bootstrap, compute worker,
  packages, scripts, tests, and deployment tooling;
- classify each variable by owner, required runtime, default, validation,
  public/server-only exposure, compatibility status, and removal condition;
- reconcile `.env.example`, tracked deployment examples, Compose files, and
  active environment-variable documentation against that inventory;
- review locally present gitignored `.env*` files against the canonical names
  and defaults, updating them where needed without committing, printing, or
  documenting secret values;
- remove stale variables and duplicate aliases completely, unless they have an
  explicit compatibility-register entry and removal condition;
- the shared resolver must not depend on Next, Fastify, AWS clients, or process
  startup side effects;
- callers may adapt the resolved config to their own runtime clients;
- environment mutation, if still required by bootstrap, remains a bootstrap
  concern layered over the pure resolver;
- preserve the active `S3_ENDPOINT` deprecation behavior until its planned
  removal.

Acceptance criteria:

- every active environment-variable read has one canonical name, owner,
  validation/default policy, and active documentation entry where appropriate;
- `.env.example`, active docs, local-development instructions, deployment
  examples, and Compose configuration agree with the implemented contract;
- locally present gitignored `.env*` files have been reconciled without adding
  secrets or ignored files to version control;
- no removed or renamed variable remains in active code, templates, tests,
  examples, or documentation, except a registered compatibility alias;
- no app or worker file imports source through `packages/bootstrap/src/...`;
- storage transport validation has one test suite;
- bootstrap, Next, and worker produce the same transport decision for the same
  environment;
- package exports make the dependency explicit.

### Step 8: Second Dead-Code and Boundary Audit

Status: pending after Steps 3 through 7.

Review:

- unreferenced files and exports;
- unused dependencies and package exports;
- active docs pointing at removed routes/config;
- duplicate parsers, retry loops, storage helpers, and error mappings;
- cross-package relative imports;
- Node-only dependencies reachable from client bundles;
- broad barrel exports that hide ownership;
- stale comments naming removed components or architectures;
- tests that assert source strings instead of behavior where a behavioral test
  is now practical;
- file-size inventory again, with an explicit keep/split decision for every
  remaining file over roughly 600 lines.

The size threshold is a review trigger, not a failure condition.

Acceptance criteria:

- every retained compatibility path has a reason and removal condition;
- no verified dead runtime module remains;
- remaining large files have one cohesive owner or a documented follow-up;
- active architecture docs match the final route and package layout.

### Execution Order

Steps 1 through 6 are complete. Continue using the canonical roadmap numbers:

- **Step 7:** move storage transport resolution into an explicit shared package
  and complete the environment-variable sweep;
- **Step 8:** run the final dead-code, dependency, documentation, and large-file
  audit.

Every step should leave the branch buildable and independently reviewable.

### Definition of Done

This cleanup plan is complete when:

1. All verified dead paths in Step 1 are removed or explicitly documented as
   intentional with a removal condition.
2. Worker routes and job implementations have clear domain-owned modules with
   small composition roots.
3. `TTSContext` is a public facade rather than the owner of every playback and
   export lifecycle.
4. Settings and document-list presentation are separated from their mutation
   and persistence controllers.
5. Shared runtime configuration is imported through an explicit package
   boundary, and code, env templates, ignored local env files, deployment
   examples, and active docs agree on the current environment contract.
6. No active docs, generated types, tests, or clients reference removed routes.
7. Remaining large files have been reviewed and are either cohesive or tracked
   with a concrete follow-up.
8. The full validation ladder passes from a clean working tree.
