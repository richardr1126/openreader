# Unified Reader Bootstrap and Readiness

Status: implementation complete. The unified bootstrap, renderer surface
contract, server-owned post-settings plan flow, and bounded production browser
verification are complete.

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
function ReaderShell({
  documentId,
  readerType,
  children,
}: {
  documentId: string;
  readerType: ReaderType;
  children: (props: ReaderRendererProps) => ReactNode;
}) {
  const bootstrap = useReaderBootstrap(documentId);
  const [rendererReady, setRendererReady] = useState(false);

  if (bootstrap.result.status === 'pending') {
    return <ReaderLoader progress={bootstrap.result.progress} />;
  }

  if (bootstrap.result.status === 'error') {
    return <ReaderError result={bootstrap.result} />;
  }

  return (
    <>
      {!rendererReady && <ReaderLoader />}
      <div hidden={!rendererReady}>
        {children({
          payload: bootstrap.result.payload,
          bootstrap,
          rendererReady,
          onReady: () => setRendererReady(true),
          onError: reportRendererError,
        })}
      </div>
    </>
  );
}
```

The shell uses a render prop because each route owns different reader chrome,
settings, and renderer-specific document state. It keys readiness to the
authoritative document and plan surface, supports renderer retry, and gates
progress persistence. It must not expand into a general readiness framework.

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

Each reader route supplies its renderer to the shared shell through the same
boundary.

```ts
type ReaderRendererProps<T extends ReaderType> = {
  payload: Extract<ReaderPayload, { readerType: T }>;
  bootstrap: ReturnType<typeof useReaderBootstrap>;
  rendererReady: boolean;
  onReady: () => void;
  onError: (error: Error) => void;
};
```

Each renderer calls `onReady` once its initial visible surface is usable.
Before readiness, any terminal renderer failure must reach the shell through
`onError` so the shared error and retry presentation replaces the loader.

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
  route-triggered playback-plan preparation during initial open;
- PDF parsed-artifact loading is disabled until aggregate bootstrap readiness,
  so it no longer competes with bootstrap parse observation;
- the PDF-specific parse loader and `ReaderPhaseLoader` have been replaced by
  one `ReaderLoader`, with optional aggregate PDF parse progress;
- all three routes render one `ReaderShell`, which owns bootstrap
  pending/error presentation, initial renderer reveal, renderer retry, and the
  progress-persistence gate;
- the shared shell supplies PDF, EPUB, and HTML with the same
  `onReady`/`onError` renderer boundary;
- the ready PDF payload includes its immutable parsed document, eliminating the
  second parsed-artifact query, SSE subscription, cache key, and retry loop;
- playback-plan operations reuse a succeeded artifact pointer; cache clearing
  invalidates the matching operation before deleting that artifact;
- reader cleanup releases route load guards before clearing shared playback
  state, so React's development remount check can restore the supplied plan;
- cancelled bootstrap streams absorb upstream reader cancellation instead of
  surfacing an unhandled response-aborted rejection;
- route-local aggregate load derivation and readiness latches have been deleted;
- EPUB placement and initial-highlight failures reach the shared renderer error
  and retry boundary, while post-ready relocations remain renderer mechanics;
- PDF readiness is one document/page/layout/segment surface commit requiring the
  active canvas, text layer, and configured highlight (or explicit no-highlight
  work);
- the PDF startup retry timer and the asynchronous PDF highlight worker have
  been deleted;
- plan-affecting document and user settings reacquire aggregate bootstrap, and
  the client playback/export layer only consumes the supplied plan;
- the obsolete client playback-plan POST and plan-resolution routes have been
  deleted; the seek-layout route remains a consumer of server-produced timing;
- TypeScript, the full unit suite, production build, compute-boundary check,
  server-bundle guard, and route-error check pass for this slice.

The work so far removed substantially more production client code than it
added. Bounded PDF, EPUB, and HTML browser smoke checks passed against the
embedded document storage and compute worker.

## Completed Hard Cut

The final hard-cut work completed the following items.

### 1. EPUB renderer failures reach the shell

EPUB placement and initial-highlighting failures now update renderer-local
placement when appropriate and report through `ReaderShell.onError`. After the
initial commit, relocation/highlight mechanics do not revoke the shell's
established readiness or disable playback.

### 2. PDF has one real initial-surface commit

PDF now uses one identity covering the active document, page, layout, and
selected plan segment. The renderer reports exactly one of:

- `ready` when every required part of that initial surface has committed;
- `error` when the current surface cannot be mapped or rendered.

Empty plans and disabled highlighting explicitly count as no highlight work.
Page turns and zoom after the first commit remain renderer mechanics and do not
restart application bootstrap. The token match runs deterministically against
the committed text layer rather than introducing another asynchronous readiness
owner or timer-driven retry loop.

### 3. PDF startup has no retry timer

Initial document adoption is idempotent under React development remounts and
returns a definitive `loaded`, `superseded`, or `failed` result. The timed
second attempt is deleted.

### 4. Plan-affecting settings changes remain server-owned

Language, voice, speed/segmentation, PDF block-kind, and audio-cache changes
reacquire aggregate bootstrap. Playback and document export consume the adopted
bootstrap plan; neither can create or poll a playback-plan operation. Ordinary
playback sessions and seek-layout consumption remain client-owned.

### 5. Non-happy-path and post-ready verification

Focused architecture, contract, unit, and bounded browser coverage now includes:

- EPUB placement or highlight failure reaching the shared retry UI;
- retryable bootstrap failure and retry;
- saved-position resume;
- empty playback plans;
- PDF initial text-layer/highlight commit;
- PDF page turns and zoom after readiness;
- EPUB relocation after readiness;
- plan-affecting settings changes without client plan polling;
- PDF page turns and zoom without reopening the shared loader;
- EPUB relocation without revoking the established usable surface.

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

The completed smoke passes covered:

- fixture upload and first open for TXT, EPUB, and PDF;
- fresh PDF parsing through aggregate bootstrap;
- initial renderer reveal for all three reader types;
- an enabled playback control backed by the supplied plan;
- stable operation identity when aggregate bootstrap re-resolves after worker
  completion;
- absence of browser console errors;
- removal of the fixture documents after verification.

The final production-browser pass additionally covered:

- EPUB post-ready relocation while playback remained enabled;
- PDF initial canvas, text-layer, and highlight commit;
- PDF page turns and zoom without returning to the shared loader;
- enabled playback controls for PDF, EPUB, and HTML;
- removal of all three local smoke fixtures after verification.

## Definition of Done

The branch is complete when:

1. All reader routes use the same bootstrap hook, shell, and loader.
2. PDF is the only reader with optional parse progress.
3. A ready payload already contains the playback plan and initial position.
4. Each renderer exposes one initial `onReady` callback, reports pre-ready
   failures through `onError`, and keeps its internal lifecycle private.
5. Initial open and plan-affecting settings changes consume a bootstrap-supplied
   plan without creating or polling another plan from the client.
6. Pending bootstrap updates arrive through one aggregate SSE subscription,
   with no polling interval.
7. Replaced readiness hooks, flags, effects, timers, and contexts are deleted,
   including the PDF startup retry timer.
8. There is no XState, Zustand, compatibility layer, fallback reader path, or
   bootstrap worker job.
9. The final change is a clear net reduction in production client code.

Simplicity and deletion are acceptance criteria, not follow-up cleanup.

All definition-of-done items are implemented.
