# OpenReader Agent Guide

This file gives future coding agents the durable context needed to work safely
and effectively in this repository. Read the relevant documents in `v5/`
before changing an architectural boundary. Never place passwords, API keys,
database URLs, or other secrets in this file, commits, logs, or PR text.

## Project

OpenReader is a self-host-friendly Next.js document reader with synchronized
text-to-speech playback for EPUB, PDF, TXT, Markdown, and DOCX. It supports
progressive generation, a durable reusable document-audio timeline, word-level
alignment, PDF layout analysis, previews, and audiobook export.

The v5 architecture is a hard redesign, not a compatibility layer over every
intermediate implementation. Because v5 has not been released yet, delete
superseded v5-only paths rather than retaining duplicate logic or dead fallback
code. Preserve released v4 data and documented upgrade behavior.

The root package version intentionally remains `4.4.0` until the owner has
deployed and smoke-tested the final v5 production build and is ready to create
the `v5.0.0` release. Do not bump it early.

## Architecture Boundaries

- Next.js is the authenticated control plane. It owns users, sessions, SQL,
  authorization, provider configuration, and bounded operation creation.
- The compute worker is the heavy/long-running data plane. It owns parsing,
  layout analysis, TTS generation/alignment, derived artifacts, and cleanup.
- NATS JetStream carries durable operation/job state and events.
- Object storage is SeaweedFS locally or an S3-compatible service externally.
- The worker must not query the application database. It obtains provider
  execution configuration from the authenticated app-owned credential broker.
- Provider credentials must never appear in NATS jobs, operation state, events,
  logs, browser responses, or artifacts.
- Keep the four authentication boundaries distinct:
  1. browser to Next.js: Better Auth session/cookie;
  2. Next.js to worker: `COMPUTE_WORKER_TOKEN`;
  3. browser to worker audio: short-lived HMAC playback token;
  4. worker to app broker: `COMPUTE_CREDENTIAL_BROKER_TOKEN`.
- Existing v4 provider ciphertext remains app-owned and encrypted with
  `AUTH_SECRET`; do not invent a second at-rest key without a complete migration.

Normative architecture and history:

- `v5/PLAYBACK_ARCHITECTURE.md`
- `v5/READER_READINESS_STATE_MACHINE.md`
- `v5/AUTHENTICATION_PLAN.md`
- `v5/COMPUTE_RATE_LIMITING_PLAN.md`
- `v5/CLEANUP_PLAN.md`
- `v5/TEST_MIGRATION_PLAN.md`

## Playback Invariants

Playback behavior matters more than making a test pass or making a file short.
Preserve these contracts:

- A document has one durable canonical playback timeline. Cached/generated
  ranges remain visible and reusable across pause, seek, section changes,
  reloads, and export.
- A seek or resume must not discard the timeline or create a replacement
  playback session merely to restart audio. Refill jobs may change internally,
  but the canonical session/cache identity remains stable.
- Pause, cancellation, and superseded location changes must stop or supersede
  unnecessary forward generation. They must not leave stale generation running.
- Playback should generate far enough ahead to stay smooth under real network
  latency, while remaining responsive to a changed cursor.
- Readiness and progress should use existing SSE state rather than new polling
  loops. Avoid parallel sources of truth.
- The UI must distinguish preparing/loading/buffering from actually playing.
  Never show “playing” during a silent generation wait.
- Word highlighting must follow audio timestamps closely, especially in EPUB.
  PDF highlighting is a useful known-good comparison.
- Audio streaming must remain bounded and backpressure-aware; do not buffer an
  entire document or many whole segments in worker memory.
- Stalled-stream recovery reopens the same session only when the SSE read model
  proves cached audio is available. It must not spin or create new sessions.

The client playback controller was deliberately simplified on `main`: browser
audio lifecycle, seek policy, projection, foreground SSE/cursor ownership, and
recovery have separate owners. Do not reintroduce manual competing processing
flags, independent seek polling, duplicate cursor writers, or scattered teardown.

## Testing Workflow

Commands:

- `pnpm test` runs all Vitest projects.
- `pnpm test:e2e` runs Playwright.
- `pnpm exec tsc --noEmit` checks the application.
- `pnpm --dir packages/compute-worker exec tsc --noEmit` checks the worker.
- `pnpm build` is the production build and lint/type gate.
- `pnpm lint:route-errors` and `pnpm check:compute-boundary` enforce boundaries.

Browser tests were rebuilt from a clean slate. For new or changed user journeys:

1. Run the application and inspect the real visible behavior with computer use.
2. Reproduce the journey through user-facing controls.
3. Fix product defects in product code; do not encode a broken state into tests.
4. Add the smallest useful Playwright assertion, preferring roles and labels.
5. Use targeted runs only while diagnosing. Before completion, run the complete
   Vitest suite and complete Playwright matrix.

Current Playwright policy:

- Tests are fully parallel with `workers: '50%'`. Never change this to 100%; it
  can freeze the development machine.
- Chromium and WebKit are enabled.
- Firefox projects remain present but commented out because Playwright Firefox
  hangs at 100% CPU on macOS 27. Do not silently re-enable Firefox, replace the
  local matrix with Linux, or Dockerize it as a workaround. Revisit only after
  confirming an upstream fix with the owner.
- True generation/playback coverage is intentionally one consolidated journey
  per enabled browser. It exercises every accepted document type.
- True playback cases do not run in GitHub CI because CI lacks the external TTS
  service; ordinary browser journeys still run there.
- As of 2026-09-07 the expected clean result is 680 Vitest tests and 24 local
  Chromium/WebKit Playwright cases. Treat the count as a checkpoint, not a rule
  preventing legitimate new coverage.

## Local Stack Discipline

Port 3003 belongs to one app stack at a time. Duplicate stacks have repeatedly
caused conflicts, high CPU, misleading failures, and overheating.

- Before starting a stack or E2E run, check whether port 3003 is already in use.
- Playwright owns and tears down its own stack. Do not start a manual Compose or
  Next.js stack before `pnpm test:e2e`.
- Never run a manual stack and the Playwright stack simultaneously.
- The owner may already have a Supertonic-compatible TTS server in an iTerm
  window. Do not kill or restart processes you did not start.
- Stop only the exact servers/processes launched for the current task.
- Avoid broad process-killing commands and repeated stack restarts.
- When manual testing is genuinely needed, use the existing Docker Compose
  examples or the owner's normal `pnpm build` then `pnpm start` flow.
- After tests, confirm port 3003 is free. Do not leave background stacks unless
  the owner explicitly asks to smoke-test one.

## Code and Cleanup Preferences

- Prefer deletion and one clear owner over adapters, aliases, compatibility
  layers, duplicate state, or dead code.
- Extract by cohesive ownership, not merely line count. Moving complexity to a
  new file is not itself simplification.
- Do not add a library, state machine framework, schema column, environment
  variable, or architectural layer without demonstrating that it is necessary.
- Ask before a schema addition or migration whose need is not already explicit.
- When replacing a route or protocol, remove its implementation, callers,
  schemas, generated types, tests, and active documentation together.
- Preserve Playwright dependencies, scripts, configuration, and GitHub workflows;
  the suite is active even when individual cases are being replaced.
- Preserve user changes in a dirty worktree. Inspect and checkpoint them before
  broad deletion or refactoring.
- Use `apply_patch` for edits and `rg`/`rg --files` for searches.
- Prefer product fixes over unusual test setup or assertions tailored to bugs.

## Collaboration Preferences

- Be direct about the observed failure, its evidence, and the actual fix. Avoid
  vague status messages or repeatedly saying a test is “some EPUB thing.”
- Do not claim a platform has no fix without verifying it. Do not substitute an
  unwanted workaround for the requested environment.
- Work efficiently: avoid repeated server startups, unnecessary selective runs,
  redundant polling, and live GitHub watchers. Use bounded status checks.
- Explain material architecture or data-model decisions before expanding scope.
- If behavior regressed, compare recent commits and the root v5 documents before
  redesigning it; many playback invariants were solved and documented already.
- Use the browser and logs together for product diagnosis. Production latency and
  event delivery can expose issues that a fast local stack hides.
- Never attribute work to an agent or tool. Commits, PR titles and bodies,
  review replies, issue comments, and code must not contain `Co-Authored-By`
  agent trailers, session links, "Generated with/by" footers, or model names,
  and commits use the owner's git identity rather than an agent's.
- Commit only when requested, using a concise conventional message. Before a PR
  merge, inspect all inline/general comments and checks, fix valid findings,
  revalidate, then squash-merge.

## Deployment and Release Workflow

- Production web deploys through Vercel from `main`.
- The external compute worker runs on Railway and is redeployed separately from
  the GHCR `main` image.
- Manual Docker publishing uses `.github/workflows/docker-publish.yml` on ref
  `main` with `use_latest_tag=false`; this publishes branch-tagged `main` images.
- Production database migrations are deliberate owner-coordinated operations.
  Never run them merely because a deployment is pending.
- The owner commonly takes the old production version offline, applies Neon
  migrations, deploys web and worker, smoke-tests production, and only then
  creates the final version bump/tag/release.

## Current Handoff — 2026-09-07

- `main` contains `23ddb846`, the squash merge of PR #139,
  “refactor(playback): simplify client lifecycle and seek readiness.” The later
  commits that add or maintain this guide are documentation-only.
- PR #139 passed Vitest, Playwright, Vercel, and CodeRabbit. Three valid review
  findings were fixed before merge: stale SSE subscription retargeting,
  non-terminal pending-seek expiry, and missing foreground-sync unmount cleanup.
- Docker workflow run `34154719414` completed successfully from that exact
  `main` SHA. Web and compute-worker images and multi-architecture manifests
  were published for amd64 and arm64 with the `main` tag.
- The next owner action is Railway redeployment from the new worker `main` image,
  followed by production playback smoke testing at `openreader.richardr.dev`.
- The worktree was clean immediately before this guide was created.
