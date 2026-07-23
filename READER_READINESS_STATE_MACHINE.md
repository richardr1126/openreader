# Unified Reader Bootstrap and Readiness

Status: implementation in progress. Server aggregation, the client query hard
cut, aggregate SSE transport, and the shared loader are implemented; the shared
shell remains.

This document completely supersedes the previous reader-readiness state-machine
proposal. The filename is retained so existing references continue to find the
current decision.

## Goal

PDF, EPUB, and HTML use one bootstrap contract, one client hook, one reader
shell, and one loader. PDF may add parse progress to that loader. Renderer
details remain private to each renderer.

The result must remove substantially more client code than it adds.

## Decision

Do not add XState or Zustand for reader readiness.

Use:

- one server-owned bootstrap operation;
- TanStack Query for the latest remote snapshot and explicit retry behavior;
- one Next SSE route for pending bootstrap updates;
- one small amount of local React state for the mounted renderer;
- one uniform renderer callback when the initial surface is usable.

The application-level lifecycle is intentionally small:

```text
bootstrap pending -> renderer mounting -> ready
                 \-> error
```

Canvas rendering, PDF text layers, EPUB relocation, HTML layout, initial
highlighting, and other renderer mechanics are not application states. They are
private implementation details completed before that renderer calls `onReady`.

## Non-Goals

This work does not introduce:

- a reader state machine or actor;
- a global reader store;
- parallel old and new readiness paths;
- compatibility adapters or fallback readers;
- reader-specific loader orchestration;
- additional readiness contexts;
- client coordination of parsing and playback-plan preparation;
- timers that combine independent readiness flags.

## Unified Bootstrap Contract

The server returns one discriminated result for every supported reader type.

```ts
type ReaderType = 'pdf' | 'epub' | 'html';

type ReaderBootstrapResult =
  | {
      status: 'pending';
      progress?: PdfParseProgress;
    }
  | {
      status: 'ready';
      payload: ReaderPayload;
    }
  | {
      status: 'error';
      message: string;
      retryable: boolean;
    };

type PdfParseProgress = {
  kind: 'pdf-parse';
  phase: 'queued' | 'parsing' | 'merging';
  pagesParsed: number;
  totalPages: number;
};
```

Only a pending PDF bootstrap may include `PdfParseProgress`. EPUB and HTML use
the same pending result without progress.

The ready payload contains everything required to mount the reader and begin
playback without another preparation workflow.

```ts
type ReaderPayload = PdfReaderPayload | EpubReaderPayload | HtmlReaderPayload;

type ReaderPayloadBase = {
  documentId: string;
  readerType: ReaderType;
  settings: DocumentSettings;
  plan: PlaybackPlan;
  initialPosition: ReaderPosition;
};
```

Each reader payload adds only its source and renderer-specific immutable data.
The plan and initial position are authoritative parts of the payload. TTS
consumes them; it does not launch another plan-preparation lifecycle.

## Ownership

| Concern | Owner |
| --- | --- |
| Metadata, settings, progress | Existing server services |
| PDF parse job and artifact | Compute/server pipeline |
| Playback plan | Compute/server pipeline |
| Bootstrap aggregation | One server bootstrap operation |
| Durable work | Existing PDF parse and playback-plan worker jobs |
| Initial pending/ready/error snapshot | One TanStack Query |
| Pending snapshot updates | One Next SSE route |
| Shared loading presentation | `ReaderLoader` |
| Initial renderer mount | `ReaderShell` |
| Canvas, text layer, relocation, layout | Individual renderer |
| Initial highlight | Individual renderer |
| Playback of the supplied plan | Shared playback layer |
| Progress persistence after readiness | Shared reader shell/playback boundary |

No concern has two owners.

## Server Bootstrap Operation

The bootstrap operation is a server coordinator, not a new compute-worker job.
It resolves the existing metadata, settings, source, parsed artifact where
applicable, playback plan, and initial position by composing the existing
durable PDF parse and playback-plan operations.

It returns:

- `pending` while required server work is incomplete;
- `ready` only with a complete `ReaderPayload`;
- `error` for a terminal or retryable failure.

The operation may use existing services internally. Those services do not each
need a corresponding client hook. Creating or reconnecting a bootstrap
observation must reuse the worker operations' existing idempotency keys.

The initial `POST /api/documents/[id]/reader-bootstrap` ensures the required
work and returns the current aggregate snapshot. If it is pending, the client
opens `GET /api/documents/[id]/reader-bootstrap/events`.

The SSE route:

- authenticates and resolves the current snapshot immediately;
- observes the active durable worker operation;
- emits complete `ReaderBootstrapResult` snapshots, never client-reassembled
  partial lifecycle events;
- advances from PDF parse completion to playback-plan resolution on the server;
- closes after `ready` or a terminal `error`;
- safely recomputes and reattaches after EventSource reconnects.

The connection observes work; it does not own it. Closing the browser or losing
the stream does not cancel a parse or plan job.

For serverless connection limits, EventSource reconnect is the recovery path.
The reconnect starts from the current durable snapshot rather than depending on
an in-memory event history.

## One Client Hook

There is one public orchestration hook:

```ts
const bootstrap = useReaderBootstrap(documentId);
```

It exposes the server result directly. It does not mirror query fields into
local state, derive a second lifecycle, or coordinate other readiness hooks.
The hook performs one initial query and, only while pending, one EventSource
subscription that writes full snapshots into that same query cache entry.

Retry means invoking the same bootstrap operation again. There is no
`refetchInterval`, parse polling, plan polling, readiness timer, or second cache
entry.

## One Reader Shell

All reader routes render the same shell.

```tsx
function ReaderShell({ documentId }: { documentId: string }) {
  const bootstrap = useReaderBootstrap(documentId);
  const [rendererReady, setRendererReady] = useState(false);

  if (bootstrap.status === 'pending') {
    return <ReaderLoader progress={bootstrap.progress} />;
  }

  if (bootstrap.status === 'error') {
    return <ReaderError result={bootstrap} />;
  }

  return (
    <>
      {!rendererReady && <ReaderLoader />}
      <ReaderRenderer
        payload={bootstrap.payload}
        hidden={!rendererReady}
        onReady={() => setRendererReady(true)}
      />
    </>
  );
}
```

The implementation may reset `rendererReady` when `documentId` changes, but it
must not expand this into a general readiness framework.

## One Loader

`ReaderLoader` is shared by PDF, EPUB, and HTML.

```ts
type ReaderLoaderProps = {
  progress?: PdfParseProgress;
};
```

Without progress it shows the standard reader loading presentation. With PDF
progress it additionally shows the parse phase and page count. There are no
reader-specific loader state machines or duplicated loader components.

## Uniform Renderer Contract

The shared dispatch component selects a renderer from the ready payload.

```ts
type ReaderRendererProps = {
  payload: ReaderPayload;
  hidden: boolean;
  onReady: () => void;
  onError?: (error: Error) => void;
};
```

Each renderer calls `onReady` once its initial visible surface is usable.

- PDF privately completes its initial page, text layer, and configured initial
  highlight.
- EPUB privately completes its initial rendition and relocation.
- HTML privately completes its initial document layout and highlight.

The shell does not receive intermediate renderer events. Page turns, resize,
zoom, word highlighting, and playback-follow navigation remain ordinary
renderer behavior after initial readiness; they do not restart bootstrap.

## Effect Policy

Effects are allowed only to synchronize React with an external system.

Valid examples:

- subscribing to browser or renderer events;
- controlling audio playback;
- persisting reader progress;
- cancelling external work on unmount.

The following patterns must be removed.

### Mirrored derived state

```ts
useEffect(() => setReady(sourceReady && planReady), [sourceReady, planReady]);
```

Derive the value during render or remove the independent inputs through the
bootstrap contract.

### Effect-driven orchestration

```ts
useEffect(() => {
  if (artifactReady && planIdle) preparePlan();
}, [artifactReady, planIdle]);
```

Preparation belongs to the server bootstrap operation.

### Timer-based readiness

```ts
useEffect(() => {
  const timer = setTimeout(checkAgain, 100);
  return () => clearTimeout(timer);
}, [someReadinessFlag]);
```

Renderers use their real completion callback. Pending server work is delivered
by the bootstrap SSE route.

### State copied between contexts

Query results, plans, positions, and readiness are passed as data. They are not
copied into another context and synchronized with effects.

## Deletion Targets

The hard cut should remove the replaced instances of:

- per-reader load-state derivation;
- PDF/EPUB/HTML readiness booleans;
- client playback-plan preparation;
- duplicate parse and plan polling hooks;
- effects that select an initial ordinal after a plan arrives;
- generic `isReaderReady` and `isViewerReady` synchronization;
- loader phase aggregation in route components;
- timer retries for initial readiness;
- readiness callbacks threaded through unrelated contexts;
- obsolete adapters, re-exports, and compatibility types.

Repository search should show that each deleted concept has no remaining alias
under a new name.

## Current Implementation State

Implemented:

- unified `ReaderBootstrapResult`, payload, position, and playback-plan types;
- `POST /api/documents/[id]/reader-bootstrap`;
- server aggregation of metadata, document settings, saved position, user TTS
  preferences, PDF parse readiness, and the authoritative playback plan;
- PDF parse progress mapping into the unified pending result;
- one public `useReaderBootstrap(documentId)` query;
- one aggregate bootstrap SSE route that follows PDF parsing into playback-plan
  preparation and updates the existing query cache entry;
- direct adoption of the supplied plan by the shared playback layer;
- removal of `useDocumentMetadata`, `useDocumentSettings`,
  `useDocumentProgress`, the old client bootstrap phase resolver, and
  route-triggered playback-plan preparation;
- PDF parsed-artifact loading is disabled until aggregate bootstrap readiness,
  so it no longer competes with bootstrap parse observation;
- the PDF-specific parse loader and `ReaderPhaseLoader` have been replaced by
  one `ReaderLoader`, with optional aggregate PDF parse progress;
- TypeScript, the full unit suite, production build, compute-boundary check,
  server-bundle guard, and route-error check pass for this slice.

Temporary implementation that must be replaced, not retained:

- the three routes still own separate loader placement and renderer-mount
  presentation;
- route-local load derivation and several readiness booleans still exist;
- the PDF renderer still fetches the ready parsed artifact after aggregate
  bootstrap rather than receiving all renderer-immutable bootstrap data through
  the final payload.

## Remaining Implementation Sequence

### 1. Shared shell and renderers

Connect `useReaderBootstrap`, `ReaderShell`, `ReaderLoader`, and the uniform
renderer contract for PDF, EPUB, and HTML. PDF passes optional parse progress.
Cut all three routes to the shared path rather than retaining parallel paths.

Move any remaining immutable renderer bootstrap data into `ReaderPayload` as
part of this cut. Do not retain a second initial artifact/source readiness
workflow.

### 2. Final deletion and effect audit

Delete every replaced hook, flag, context field, timer, effect, loader branch,
and compatibility type. Review every remaining readiness-related effect against
the effect policy above.

If a slice adds more orchestration code than it removes, stop and simplify it
before continuing.

## Verification

Until the known Playwright infrastructure failures are repaired separately,
this branch uses:

- TypeScript checking;
- focused unit tests for bootstrap result handling;
- existing compute and playback-plan tests;
- production builds;
- bounded manual smoke checks for PDF, EPUB, and HTML.

Playwright failures that predate this work are recorded but are not used to add
client lifecycle machinery.

Smoke checks cover:

- first open for all three reader types;
- saved-position resume;
- playback using the supplied plan;
- PDF parse progress;
- initial renderer reveal;
- retryable bootstrap errors;
- empty playback plans;
- PDF page turns and zoom after readiness;
- EPUB relocation after readiness;
- HTML navigation after readiness.

## Definition of Done

The branch is complete when:

1. All reader routes use the same bootstrap hook, shell, and loader.
2. PDF is the only reader with optional parse progress.
3. A ready payload already contains the playback plan and initial position.
4. Each renderer exposes one initial `onReady` callback and keeps its internal
   lifecycle private.
5. TTS consumes the supplied plan without preparing another one.
6. Pending bootstrap updates arrive through one aggregate SSE subscription,
   with no polling interval.
7. Replaced readiness hooks, flags, effects, timers, and contexts are deleted.
8. There is no XState, Zustand, compatibility layer, fallback reader path, or
   bootstrap worker job.
9. The final change is a clear net reduction in production client code.

Simplicity and deletion are acceptance criteria, not follow-up cleanup.
