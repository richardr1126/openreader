# Unified Compute Limiting Architecture

Status: implemented; direct admin controls replace the superseded rollout-mode UI.

This document is the normative v5 plan for limiting user-initiated compute,
metered TTS usage, provider throughput, queued work, and worker execution. It
supersedes the separate TTS character limiter and PDF job-event limiter.

Implementation history and acceptance evidence should be recorded at the end
of this document as each phase lands.

---

## Decisions

OpenReader will use one shared compute-policy vocabulary with different
enforcement mechanisms at the boundaries that own the relevant state:

- The Next.js control plane owns per-user, anonymous-device, IP, and site
  admission, active-work, and usage limits in SQL.
- The compute worker owns local execution scheduling and provider-capacity
  coordination. It never reads the application database.
- NATS JetStream continues to own durable job and operation state. It is not a
  second usage ledger.
- Object storage remains the authority for whether a derived artifact or TTS
  segment already exists.
- Every limiting area and every compute action is independently configurable in
  **Settings -> Admin** and through the runtime seed JSON.
- User and provider limits have a direct enabled switch. Enabled means enforced;
  disabled means bypassed. Worker safety limits are always enforced.
- Existing user usage is not migrated. Deploying this change intentionally
  gives every user a fresh allowance.
- The obsolete `user_tts_chars` and `user_job_events` tables, their scheduled
  tasks, exports, cleanup paths, settings, routes, tests, and documentation are
  removed in the same migration. There is no dual-write or runtime fallback.
- Existing administrator policy choices should be converted once into the new
  policy document where practical. Usage rows are discarded; configured limits
  are not user usage and should not be silently lost.

The architecture deliberately does not force quotas, rates, active leases, and
worker semaphores through one algorithm. They share types, policy resolution,
status, errors, observability, and administration, but each is enforced by the
smallest correct primitive.

## TTS Threshold Decision

TTS character allowance is a soft, segment-level threshold rather than a hard
mathematical cap.

When an uncached segment is about to be synthesized:

1. If the applicable bucket is already at or above its threshold, generation
   of that segment is denied.
2. If the bucket is below its threshold, the complete segment is allowed and
   charged once, even when it crosses the threshold.
3. A later uncached segment is denied until the bucket resets.
4. Cached segments remain available and do not consume allowance.

This preserves sentence-level playback, feels generous to the user, and bounds
bonus usage to one canonical segment. It must not revert to whole-plan
accounting or to `current + segmentCharacters <= threshold` behavior.

Example with a 50,000-character threshold:

```text
current usage                 49,900
next uncached segment            420
result                        50,320  allowed
following uncached segment             denied
cached segment at any ordinal           allowed, no charge
```

The atomic predicate is `used < threshold`, followed by `used += units` in the
same transaction. Concurrent callers cannot each observe the old value and
independently cross the threshold.

---

## Goals

1. Protect provider spend, application-database capacity, NATS backlog, object
   storage, worker CPU, worker memory, and external provider throughput.
2. Give each compute action its own independently editable policy.
3. Count only new work. Artifact reuse, operation reuse, cached TTS audio, and
   idempotent retries do not consume usage a second time.
4. Keep the browser, app, worker, NATS, and storage sources of truth distinct.
5. Make all enforcement atomic enough that concurrency cannot materially bypass
   an enabled limit.
6. Keep live playback responsive while preventing exports and background work
   from starving or overwhelming the worker.
7. Return typed, actionable limit states rather than generic failures or silent
   retry loops.
8. Delete superseded code and data structures as part of the cutover.
9. Keep the implementation cohesive enough to complete in one PR without an
   extended compatibility period.

## Non-Goals

- Do not implement database-vendor distributed two-phase commit.
- Do not make the compute worker query SQL.
- Do not put provider credentials, raw IP addresses, or device cookies in NATS.
- Do not bill cached TTS playback, playback-plan creation, alignment, or export
  assembly as TTS provider characters.
- Do not interrupt synthesis in the middle of a canonical segment.
- Do not make upload-size validation part of compute limiting. `maxUploadMb`
  remains a separate request/storage safety limit.
- Do not treat API request throttling, such as Better Auth rate limiting, as a
  substitute for compute admission.
- Do not preserve old v5-only limiter APIs or tables after the new callers are
  wired.
- Do not bump the root package version before the owner completes the v5
  production deployment and smoke test.

---

## Terminology

The word "limit" is qualified throughout the implementation:

| Term | Meaning | Owner |
| --- | --- | --- |
| Admission rate | How often new work may be requested | Next.js + SQL |
| Active limit | How much queued/running work may exist concurrently | Next.js SQL lease projection |
| Usage allowance | Metered work consumed during a fixed window | Next.js + SQL |
| Queue limit | How much unstarted work may wait for a kind | Worker/NATS |
| Execution limit | How many jobs or expensive phases may execute together | Worker scheduler |
| Provider limit | Requests, characters, and calls in flight against one provider | Worker + NATS coordination |
| Threshold | A soft usage boundary that permits the unit which crosses it | SQL usage engine |
| Cap | A strict boundary that may not be exceeded | Admission/scheduler engine |

An **action** is a policy identity. Most actions match a worker operation kind.
`tts_synthesis` is a metered sub-action because actual provider work happens per
segment inside a `tts_playback` operation.

```ts
type ComputeAction =
  | 'pdf_layout'
  | 'tts_playback'
  | 'tts_playback_plan'
  | 'tts_playback_export'
  | 'document_preview'
  | 'document_conversion'
  | 'account_export'
  | 'tts_synthesis';
```

Adding a new worker operation kind must fail type checking until it declares an
app admission policy and a worker execution policy. Metered sub-actions must be
declared explicitly; they are not inferred from operation names.

---

## Policy Model

The runtime setting is one versioned, fully validated policy document. Keeping
it as one document allows cross-field validation, atomic admin saves, a single
policy version for worker refresh, and complete seed JSON coverage.

The illustrative contract below is normative in shape, although implementation
types may use discriminated unions to make invalid metric combinations
unrepresentable.

```ts
type LimitScope = 'user' | 'anonymous_device' | 'ip' | 'site';

interface ComputeLimitPolicyDocument {
  schemaVersion: 2;
  actions: Record<WorkerOperationAction, OperationActionPolicy> & {
    tts_synthesis: TtsSynthesisActionPolicy;
  };
  worker: {
    maxExecutingPerWorker: number;
    resources: Record<WorkerResource, number>;
    policyRefreshSeconds: number;
  };
  providers: {
    defaults: ProviderLimitPolicy;
    overrides: Record<string, ProviderLimitPolicy>;
  };
}

interface AdmissionPolicy {
  windows: Array<{
    scope: LimitScope;
    windowSeconds: number;
    limit: number;
  }>;
  active: Array<{
    scope: 'user' | 'site';
    limit: number;
    leaseSeconds: number;
  }>;
}

interface OperationActionPolicy {
  enabled: boolean;
  admission: AdmissionPolicy;
  usage: [];
  execution: {
    priority: 'interactive' | 'foreground' | 'background';
    maxQueued: number;
    maxConcurrentPerWorker: number;
    resources: Partial<Record<WorkerResource, number>>;
    maxQueueAgeSeconds: number;
  };
}

interface TtsSynthesisActionPolicy {
  enabled: boolean;
  admission: { windows: []; active: [] };
  usage: Array<{
    scope: LimitScope;
    audience: 'anonymous' | 'authenticated' | 'all';
    metric: 'characters';
    window: 'utc_day';
    limit: number;
    boundary: 'soft_unit';
  }>;
}

type WorkerResource =
  | 'cpu_heavy'
  | 'model_inference'
  | 'whisper_alignment'
  | 'ffmpeg'
  | 'libreoffice'
  | 'archive_io';

interface ProviderLimitPolicy {
  enabled: boolean;
  maxConcurrent: number;
  requestsPerMinute: number;
  charactersPerMinute: number;
  maxWaitSeconds: number;
}
```

Validation requirements:

- The document must contain exactly the supported schema version and action
  keys. Unknown actions and fields are rejected.
- Every count, duration, and byte value is a bounded positive integer.
- An enabled action cannot omit every admission, usage, queue, and execution
  constraint.
- `tts_synthesis` character usage must use `soft_unit`.
- Version 2 rejects usage entries on other actions until that action wires a
  concrete measured unit at its owning boundary; their admission boundaries
  are strict.
- Anonymous-device scopes are valid only for actions reachable by anonymous
  users.
- Provider override keys must be valid provider references; stale overrides may
  remain visible but are marked as not currently attached to a provider.
- The worker total and resource limits must be internally possible; an action
  cannot request more units of a resource than the worker owns.

### Defaults and cutover behavior

- Every action has an explicit direct enabled state and editable numeric values.
- The misleading PDF "sustained equals concurrency" interpretation is removed;
  `pdf_layout` has a separate active limit.
- Worker execution limits always enforce safe compiled defaults, even when user
  request limits are disabled.
- Existing usage counters are not migrated. Existing version 1 rollout-mode
  policy documents are not interpreted as version 2 configuration.

The original migration wrote the first policy document and removed superseded
rows. The schema version 2 migration removes that v5-only rollout-mode setting
so the maintained direct-control default or runtime seed becomes authoritative.
Runtime code does not retain a compatibility path.

Exact production numbers should be finalized using current operation timings;
the architecture does not encode unexplained constants as product truth.

The maintained self-host bootstrap policy leaves operation admission limits
disabled by default. Their configured values remain available as opt-in
guardrails for a public or shared installation. Uncached-synthesis usage limits
are also opt-in, while worker, resource, and provider capacity remain enforced
as lightweight protection for the host and upstream services.

| Action | Enabled by default | User admission windows | User active | Site active | Queue / per-worker concurrent |
| --- | --- | --- | ---: | ---: | --- |
| `tts_playback` | no | 12 / 60 seconds; 60 / hour | 2 | 50 | 100 / 1 |
| `tts_playback_plan` | no | 12 / 60 seconds; 60 / hour | 2 | 20 | 100 / 1 |
| `pdf_layout` | no | 8 / 60 seconds; 24 / 600 seconds | 1 | 8 | 50 / 1 |
| `tts_playback_export` | no | 2 / 600 seconds; 6 / day | 1 | 4 | 20 / 1 |
| `document_preview` | no | 30 / 600 seconds; 200 / day | 4 | 20 | 200 / 1 |
| `document_conversion` | no | 4 / 600 seconds; 20 / day | 1 | 8 | 50 / 1 |
| `account_export` | no | 2 / hour; 4 / day | 1 | 4 | 20 / 1 |

`tts_synthesis` is disabled by default. When enabled, its configured daily
thresholds are: anonymous user 50,000; authenticated user 500,000; anonymous IP
100,000; authenticated IP 1,000,000. Anonymous-device scope uses the anonymous
user threshold. All use the approved `soft_unit` boundary.

Bootstrap worker execution values are deliberately close to the effective
three-family behavior of the current default without retaining three unrelated
gates:

```text
maxExecutingPerWorker       3
cpu_heavy                   1
model_inference             1
whisper_alignment           1
ffmpeg                      1
libreoffice                 1
archive_io                  2
```

Every operation kind starts with `maxConcurrentPerWorker = 1`. Provider limits
are enabled with three concurrent requests, 60 requests/minute, 100,000
characters/minute, and a 30-second maximum wait. Admins should customize the
default or a named override to match their service plan.

---

## Admin Settings and Runtime Seed JSON

The Admin panel receives a dedicated **Rate limiting** group rather than
continuing the old mixed TTS/PDF controls.

It contains:

- A policy card for every `ComputeAction`.
- A direct enabled switch for every user and provider limiting area.
- Named numeric controls for admission windows, active limits, usage
  allowances, queues, concurrency, priorities, queue age, worker totals,
  resources, and provider defaults/overrides.
- A concise explanation that the TTS character value is a soft per-segment
  threshold and cached segments are free.
- One clear validation error prevents an incomplete or cross-field-invalid
  policy document from being saved.
- Reset-to-default for the complete policy document.
- Source metadata showing default, JSON seed, or admin ownership.

The runtime config schema adds the validated `computeLimitPolicies` value and
removes all superseded TTS/PDF limiter keys after the one-time migration.
`maxUploadMb` remains separate.

Both seed forms must support the complete policy document:

```json
{
  "version": 1,
  "runtimeConfig": {
    "computeLimitPolicies": {
      "schemaVersion": 2,
      "actions": {
        "pdf_layout": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 8, "windowSeconds": 60 },
              { "scope": "user", "limit": 24, "windowSeconds": 600 }
            ],
            "active": [
              { "scope": "user", "limit": 1, "leaseSeconds": 86400 },
              { "scope": "site", "limit": 8, "leaseSeconds": 86400 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "foreground",
            "maxQueued": 50,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 600,
            "resources": { "cpu_heavy": 1, "model_inference": 1 }
          }
        },
        "tts_playback": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 12, "windowSeconds": 60 },
              { "scope": "user", "limit": 60, "windowSeconds": 3600 }
            ],
            "active": [
              { "scope": "user", "limit": 2, "leaseSeconds": 1800 },
              { "scope": "site", "limit": 50, "leaseSeconds": 1800 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "interactive",
            "maxQueued": 100,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 60,
            "resources": {}
          }
        },
        "tts_playback_plan": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 12, "windowSeconds": 60 },
              { "scope": "user", "limit": 60, "windowSeconds": 3600 }
            ],
            "active": [
              { "scope": "user", "limit": 2, "leaseSeconds": 1800 },
              { "scope": "site", "limit": 20, "leaseSeconds": 1800 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "foreground",
            "maxQueued": 100,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 600,
            "resources": {}
          }
        },
        "tts_playback_export": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 2, "windowSeconds": 600 },
              { "scope": "user", "limit": 6, "windowSeconds": 86400 }
            ],
            "active": [
              { "scope": "user", "limit": 1, "leaseSeconds": 7200 },
              { "scope": "site", "limit": 4, "leaseSeconds": 7200 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "foreground",
            "maxQueued": 20,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 600,
            "resources": { "ffmpeg": 1, "archive_io": 1 }
          }
        },
        "document_preview": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 30, "windowSeconds": 600 },
              { "scope": "user", "limit": 200, "windowSeconds": 86400 }
            ],
            "active": [
              { "scope": "user", "limit": 4, "leaseSeconds": 1800 },
              { "scope": "site", "limit": 20, "leaseSeconds": 1800 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "background",
            "maxQueued": 200,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 3600,
            "resources": { "cpu_heavy": 1 }
          }
        },
        "document_conversion": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 4, "windowSeconds": 600 },
              { "scope": "user", "limit": 20, "windowSeconds": 86400 }
            ],
            "active": [
              { "scope": "user", "limit": 1, "leaseSeconds": 600 },
              { "scope": "site", "limit": 8, "leaseSeconds": 600 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "foreground",
            "maxQueued": 50,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 600,
            "resources": { "cpu_heavy": 1, "libreoffice": 1 }
          }
        },
        "account_export": {
          "enabled": false,
          "admission": {
            "windows": [
              { "scope": "user", "limit": 2, "windowSeconds": 3600 },
              { "scope": "user", "limit": 4, "windowSeconds": 86400 }
            ],
            "active": [
              { "scope": "user", "limit": 1, "leaseSeconds": 7200 },
              { "scope": "site", "limit": 4, "leaseSeconds": 7200 }
            ]
          },
          "usage": [],
          "execution": {
            "priority": "background",
            "maxQueued": 20,
            "maxConcurrentPerWorker": 1,
            "maxQueueAgeSeconds": 3600,
            "resources": { "archive_io": 1 }
          }
        },
        "tts_synthesis": {
          "enabled": false,
          "admission": { "windows": [], "active": [] },
          "usage": [
            { "scope": "user", "audience": "anonymous", "metric": "characters", "window": "utc_day", "limit": 50000, "boundary": "soft_unit" },
            { "scope": "user", "audience": "authenticated", "metric": "characters", "window": "utc_day", "limit": 500000, "boundary": "soft_unit" },
            { "scope": "anonymous_device", "audience": "anonymous", "metric": "characters", "window": "utc_day", "limit": 50000, "boundary": "soft_unit" },
            { "scope": "ip", "audience": "anonymous", "metric": "characters", "window": "utc_day", "limit": 100000, "boundary": "soft_unit" },
            { "scope": "ip", "audience": "authenticated", "metric": "characters", "window": "utc_day", "limit": 1000000, "boundary": "soft_unit" }
          ]
        }
      },
      "worker": {
        "maxExecutingPerWorker": 3,
        "resources": {
          "cpu_heavy": 1,
          "model_inference": 1,
          "whisper_alignment": 1,
          "ffmpeg": 1,
          "libreoffice": 1,
          "archive_io": 2
        },
        "policyRefreshSeconds": 60
      },
      "providers": {
        "defaults": {
          "enabled": true,
          "maxConcurrent": 3,
          "requestsPerMinute": 60,
          "charactersPerMinute": 100000,
          "maxWaitSeconds": 30
        },
        "overrides": {}
      }
    }
  },
  "providers": []
}
```

The documentation example must contain the real complete default object rather
than the abbreviated object above. Update together:

- `examples/openreader-seed.json` and the `.env.example` seed pointer;
- current environment-variable documentation;
- Admin panel documentation;
- TTS rate-limiting documentation, renamed or replaced by compute limiting;
- deployment examples that carry runtime seed JSON;
- runtime seed parsing and full-key coverage tests;
- client `RuntimeConfig` shape and SSR serialization tests.

Unknown policy fields must cause the complete seed to fail before any runtime
setting or provider is written, preserving the seed's current all-or-nothing
validation behavior.

### Worker policy refresh

Worker execution and provider limits are runtime admin settings, not a growing
set of worker environment variables.

- Add an authenticated app-broker read endpoint for the current validated
  policy document and stable content-derived policy version.
- Reuse the existing worker-to-app broker authentication boundary and token. No
  new secret is necessary because that token already authorizes the more
  sensitive provider-credential read.
- The worker loads the policy before starting queue consumers and refreshes it
  at the configured interval.
- A newer valid policy atomically replaces the in-memory scheduler policy.
- A refresh failure retains the last known valid policy and reports degraded
  health. On first-boot failure, the worker uses conservative compiled execution
  defaults and retries; it does not start with unlimited capacity.
- Changes to queue admission and semaphores apply without restarting. ONNX
  thread counts that are fixed when a model session is created apply on the next
  model load or worker restart and are labeled accordingly in the UI.

`COMPUTE_JOB_CONCURRENCY` is removed because the admin policy owns all worker
and per-action concurrency. Environment, Compose, bootstrap, docs, tests, and
worker-loop inputs use that policy as their single source of truth. The worker
derives its protective ONNX thread budget from the policy's worker-wide limit;
it is not a second operator setting.

---

## SQL Data Model

Three new tables replace both old limiter tables. SQLite and PostgreSQL schemas
must express the same constraints and indexes.

### `compute_limit_admissions`

One row represents one admitted user-originated compute attempt or one canonical
TTS session allowance. It is also the app-owned projection used for active
limits and the opaque subject through which a worker consumes metered usage.

| Column | Type | Contract |
| --- | --- | --- |
| `id` | text UUID, primary key | Opaque admission identifier safe to place in a job/session |
| `request_key` | text | Idempotency identity selected by the action adapter |
| `user_id` | text, FK to user, cascade | Better Auth user, including anonymous users |
| `is_anonymous` | boolean | Audience snapshot for later worker-originated usage checks |
| `action` | text | Valid `ComputeAction` |
| `state` | text | `reserved`, `active`, `finished`, or `cancelled` |
| `operation_id` | text, nullable | Worker operation after creation |
| `device_scope_key` | text, nullable | HMAC-derived anonymous device bucket identity |
| `ip_scope_key` | text, nullable | HMAC-derived IP bucket identity |
| `active_scopes_json` | text JSON | Exact active bucket scopes charged to this admission, including an empty array |
| `policy_version` | integer | Policy used when the admission was created |
| `created_at` | epoch milliseconds | Attempt time |
| `activated_at` | epoch milliseconds, nullable | When real work/session became active |
| `finished_at` | epoch milliseconds, nullable | Terminal transition time |
| `lease_expires_at` | epoch milliseconds | Crash-safe active lease expiry |

Constraints and indexes:

- Unique `(user_id, action, request_key)` makes browser/network retries
  idempotent for the same attempt.
- Index `(user_id, action, state, lease_expires_at)` supports user active-limit
  resolution and account export.
- Index `(action, state, lease_expires_at)` supports site active limits and
  expired-lease reconciliation.
- `operation_id`, when present, is indexed for terminal callbacks.
- A state check constraint prevents unrecognized lifecycle values where the
  database dialect supports it consistently.

`request_key` is action-owned:

| Action | Request key |
| --- | --- |
| `pdf_layout` | document/version/force token |
| `tts_playback` | canonical session incarnation |
| `tts_playback_plan` | plan signature |
| `tts_playback_export` | export artifact id plus attempt |
| `document_preview` | source fingerprint plus preview kind |
| `document_conversion` | conversion id plus source fingerprint |
| `account_export` | export artifact id plus attempt |
| `tts_synthesis` | Does not create admissions; it consumes through the owning playback admission |

Normal artifact or operation resolution happens before admission. If a race
still causes the worker to return an existing operation, the new worker response
must say `created` or `reused`; a redundant admission is cancelled immediately
and its active gauge is released. Admission-start rate may continue counting
the attempt because repeated create pressure is precisely what it protects.

### `compute_limit_buckets`

This table stores atomic fixed-window counters and active gauges.

| Column | Type | Contract |
| --- | --- | --- |
| `scope_type` | text | `user`, `anonymous_device`, `ip`, or `site` |
| `scope_key` | text | User id, HMAC backstop key, or constant site key |
| `action` | text | Valid `ComputeAction` |
| `metric` | text | `starts`, `characters`, `input_bytes`, `files`, or `active` |
| `window_start` | epoch milliseconds | Fixed-window start; `0` for active gauges |
| `window_end` | epoch milliseconds | Fixed-window end; `0` for active gauges |
| `used` | integer | Counter or current active gauge |
| `updated_at` | epoch milliseconds | Maintenance and diagnostics |

Primary key:

```text
(scope_type, scope_key, action, metric, window_start)
```

Index `(window_end, metric)` supports pruning expired fixed windows. Scope keys
for device and IP are HMAC-derived by the app with domain-separated labels;
raw values are never stored or sent to the worker.

Counter behavior:

- Strict admission: update only when `used + units <= limit`.
- Soft TTS threshold: update only when `used < limit`, then add the complete
  segment units.
- Active admission: atomically increment the `active` gauge only when
  `used + 1 <= limit`.
- Finish/cancel/expiry: atomically decrement once, never below zero.
- All user/device/IP/site buckets for one decision are updated inside one SQL
  transaction in a deterministic scope order. Failure of any binding bucket
  rolls back the entire decision.

UTC-day allowance uses `[UTC midnight, next UTC midnight)`. Admission windows
use aligned fixed windows. Multiple windows provide burst and sustained
protection. The active gauge prevents boundary bursts from becoming excess
concurrency, so a portable fixed-window implementation is preferred over the
old non-atomic rolling `COUNT(*)` query.

### `compute_limit_events`

This is the idempotency and audit record for successfully consumed usage.

| Column | Type | Contract |
| --- | --- | --- |
| `event_key` | text, primary key | Deterministic idempotency key |
| `admission_id` | text, nullable FK | Owning admission; nullable after retention cleanup if needed |
| `user_id` | text, FK to user, cascade | Account export and deletion scope |
| `action` | text | Normally `tts_synthesis`; reusable for future metered work |
| `metric` | text | Metered unit |
| `units` | integer | Units applied to every applicable bucket |
| `policy_version` | integer | Policy used for the decision |
| `created_at` | epoch milliseconds | Successful consumption time |

Index `(user_id, action, created_at)` supports account export. Only allowed
consumption is inserted. A denied segment receives no event so it can be tried
again after the bucket resets.

For TTS, the event key includes:

```text
tts_synthesis:v1:<storage-user>:<cache-epoch>:<audio-content-hash>
```

The event insert and all bucket mutations occur in one transaction. A duplicate
event returns the original allowed decision without incrementing any bucket.
Provider retry attempts within the same segment do not create new events.
Clearing the TTS cache advances the cache epoch, so genuinely regenerated audio
is eligible for a new charge.

### Why there is no reservation/commit table

This design does not initially implement reserve/commit/refund for usage. Usage
is consumed once immediately before the provider call. A failed or cancelled
provider request can therefore consume at most one segment, while the current
implementation can consume a complete plan without generating audio.

True reserve/commit/refund can be added to the event lifecycle if production
evidence shows that failed-segment charges are materially unfair. It is not
required for the initial architecture and must not be described as distributed
two-phase commit.

---

## Control-Plane Admission Flow

Every app-owned worker-operation creation path uses one shared coordinator with
small action adapters for identity and cost estimation.

```text
browser or server coordinator
        |
        v
Next: authenticate + authorize + validate
        |
        v
resolve durable artifact/current operation
        | reusable
        +------------------------------> return existing result
        |
        | new work required
        v
compute admission transaction
  - idempotency lookup
  - start-window buckets
  - active user/site gauges
  - admission row
        |
        v
create worker operation with admissionId
        |
        +-- created --> activate admission with operationId
        |
        +-- reused  --> cancel redundant admission/release active gauge
        |
        +-- failure --> cancel admission/release active gauge
```

The coordinator API should be cohesive rather than duplicated in routes:

```ts
admitCompute(input): Promise<AdmissionDecision>;
activateAdmission(input): Promise<void>;
finishAdmission(input): Promise<void>;
consumeComputeUsage(input): Promise<UsageDecision>;
```

An admission database failure for an enabled limit fails closed with a
retryable 503 before creating work. A disabled request limit does not touch
counter buckets.

Background preview denial does not fail the document upload. It leaves preview
state pending/deferred so the normal on-demand ensure path can try later.
Foreground preparation, conversion, and export return a typed limit response.

### Admission lifecycle and crash recovery

- `reserved` exists only while the app is calling the worker and has a short
  expiry.
- `active` begins only after a new operation is accepted, or when a prepared TTS
  session is activated.
- The worker sends an authenticated terminal callback for succeeded, failed,
  cancelled, or superseded operations.
- Terminal callbacks are idempotent and decrement active gauges once.
- If the callback is lost, the scheduled reconciliation task expires the lease
  and decrements it.
- Long jobs renew their admission lease at a bounded interval piggybacked on
  existing operation progress/heartbeat, not on every SSE message.
- SQL admission state is an enforcement projection. NATS operation state remains
  authoritative for the operation's actual lifecycle.

---

## TTS Segment Usage Flow

Whole-plan quota checking is deleted from session creation and export resolve.
The canonical playback session carries its opaque `admissionId` so worker-owned
continuations use the same subject.

```text
worker selects next planned segment
        |
        v
check current session generation/cursor
        |
        v
read sidecar + audio object
        | cached
        +------------------------------> play/rebuild metadata; no usage call
        |
        | missing
        v
win canonical segment generation lease
        |
        v
POST app broker: consume tts_synthesis characters
  canonical sessionId + userId + eventKey + normalized text length
        |
        +-- denied --> leave segment retryable; publish typed quota state; stop
        |
        +-- allowed/duplicate
        v
acquire provider capacity
        |
        v
call provider -> persist audio -> persist completed sidecar
```

The consume request is authenticated with the existing worker-to-app broker
token. The canonical session id resolves the admission without putting a new
internal identifier into every playback protocol. The app applies the
admission's stored user/device/IP scopes;
the worker never receives those backstop identities.

Important ordering invariants:

- Cache and current-generation checks happen before usage consumption.
- The worker respects any live foreign segment lease before usage consumption
  and writes its own generation lease before calling the provider.
- Usage consumption happens before the provider request.
- The event key makes a redelivery or provider retry free of duplicate charges.
- Quota denial is transient. Do not write a permanent `error` segment sidecar.
- Cached audio remains playable after the threshold is reached.
- Alignment and sidecar repair do not consume TTS characters.
- Whole-document export generation uses the same per-segment path; export
  assembly has its own non-character policy.

### Client-visible quota exhaustion

A worker-side denial must travel through operation/session SSE as structured
state rather than being reduced to an upstream error string.

Extend the worker error contract with:

```ts
interface ComputeLimitError {
  code:
    | 'COMPUTE_ADMISSION_RATE_LIMITED'
    | 'COMPUTE_ACTIVE_LIMITED'
    | 'COMPUTE_USAGE_LIMITED'
    | 'COMPUTE_QUEUE_LIMITED'
    | 'COMPUTE_POLICY_UNAVAILABLE';
  action: ComputeAction;
  metric?: UsageMetric;
  retryAfterMs: number;
  resetTimeMs?: number;
  limit?: number;
  used?: number;
}
```

The full player remains available after a limit is reached so the user can play,
seek through, and resume cached audio. When playback reaches an uncached denied
segment, the worker records the usage-limit stop reason without replacing the
player or discarding the canonical timeline. It must not spin new sessions or
continuation operations while the same bucket is binding. After reset, ordinary
play/resume continues on that same timeline.

---

## Worker Queue and Execution Scheduler

The current three `ConcurrencyGate` instances are replaced by one scheduler.
The documented total is then a real total rather than one independent total for
layout, plan, and playback families.

### Scheduler responsibilities

- Keep pullers bounded; a pulled message waiting briefly for its action slot
  sends `working()` heartbeats so JetStream does not redeliver it.
- Enforce `maxExecutingPerWorker` across all operation kinds.
- Enforce each action's `maxConcurrentPerWorker`.
- Acquire all declared resource units in one scheduler decision.
- Prefer interactive work, then foreground preparation, then background work.
- Keep FIFO ordering within each priority class.
- Reject excess local scheduler waiters when the action backlog reaches
  `maxQueued`; the message is NAKed back to JetStream.
- Fail work that exceeds `maxQueueAgeSeconds` with a typed retryable error rather
  than executing an obsolete request.
- Release resources in `finally` on every success, failure, abort, and shutdown.
- Expose current queue depth, running counts, resource use, and oldest queue age
  through health/diagnostic state and structured logs.

The scheduler owns local machine capacity. SQL site-active limits bound total
user-originated work across replicas; local worker limits correctly scale with
the number and size of worker replicas.

### Resource profiles

Initial profiles should reflect actual expensive phases, not historical names:

| Action | Priority | Principal resources |
| --- | --- | --- |
| `tts_playback` | interactive | provider capacity; Whisper alignment when needed |
| `tts_playback_plan` | foreground | Object I/O; bounded by per-action and worker totals |
| `pdf_layout` | foreground | model inference, CPU, memory |
| `document_conversion` | foreground | LibreOffice, CPU, memory |
| `tts_playback_export` | foreground | FFmpeg and object I/O |
| `account_export` | background | archive and object I/O |
| `document_preview` | background | CPU/rendering and object I/O |

Where a job changes resource profile during execution, the handler uses a
scoped scheduler lease around the expensive phase. In particular, TTS provider
synthesis and Whisper alignment are separate resources; export assembly does not
occupy a provider slot merely because both are TTS-related.

### Queue admission

NATS remains durable, but durability is not permission for unbounded backlog.

- App-side action/site active admission is checked before operation creation and
  publication, bounding aggregate queued-plus-running work across replicas.
- Reused deterministic operations do not consume another active admission.
- Admission decisions are returned to Next with `Retry-After`.
- Stream byte limits remain a final storage backstop, not the normal queue-limit
  mechanism.
- Consumer `max_ack_pending` and pull counts are aligned with scheduler capacity.
- A pulled message receives `working()` heartbeats while waiting and while
  legitimately executing.

---

## Provider Throughput Limiting

Provider throughput is separate from the user's daily character allowance.
Daily allowance protects site spend/fairness. Provider limiting protects an
external service's concurrency and rolling request/character constraints.

The worker resolves the effective provider first, then applies the default or
provider-specific admin policy before the upstream call.

Per provider reference:

- `maxConcurrent` is a lease released after the request settles.
- `requestsPerMinute` is strict.
- `charactersPerMinute` is strict because it represents provider throughput,
  not the user-facing generous daily threshold.
- `maxWaitSeconds` bounds how long an active playback run may wait for provider
  capacity before returning a retryable buffering/capacity state.
- An upstream 429 with `Retry-After` cools down the matching provider bucket so
  other workers do not immediately repeat the failure.

When more than one worker replica shares a provider, provider buckets and
concurrency leases are coordinated through a dedicated JetStream KV namespace
using CAS and expiring holders. Provider references and counts may be stored;
credentials may not. Single-process semaphores are insufficient because their
effective limit multiplies with replicas.

Waiting for provider capacity must remain abortable by pause, seek, superseded
generation, shutdown, and session expiry. Capacity waits do not create error
sidecars or consume another user usage event.

Live playback keeps a bounded three-segment synthesis pipeline ready in plan
order. `maxConcurrent` remains the authoritative cross-worker limit: the
pipeline cannot exceed it, and named provider overrides can reduce it for a
single-request local server or increase it only when the upstream supports that
throughput. The maintained self-host default is three, matching the worker's
total execution capacity and avoiding an accidental single-request bottleneck.

---

## Status, Errors, and Observability

Replace `/api/rate-limit/status` with `/api/compute-limits/status`. The response
contains only policies and usage relevant to the authenticated user. It does not
reveal HMAC scope keys, other users, site-provider details, or raw IPs.

The status read model includes:

- action and enabled state;
- binding scope label without its identifier;
- metric, used, threshold/cap, remaining, and reset time;
- active used/limit;
- TTS-specific wording that its character value is a soft threshold;
- no fake `Number.MAX_SAFE_INTEGER` values when a policy is disabled; use an
  explicit enabled state and nullable limit instead.

All rejections use `application/problem+json` and a truthful HTTP status:

- `429` for user, device, IP, provider, or site rate/usage limits;
- `409` only for genuine operation/session identity conflicts;
- `503` for unavailable policy enforcement or worker capacity infrastructure;
- `Retry-After` whenever a bounded retry time is known.

Structured logs and metrics include action, decision, metric, units, scope type,
policy version, queue depth, wait time, and reason code. User ids, provider keys,
IP addresses, device identifiers, and credentials are absent or hashed using the
existing logging policy.

Structured decisions are emitted for allowed and rejected enabled limits. A
disabled limit does not create misleading counter demand.

---

## Retention, Export, and Deletion

One scheduled task, `prune-compute-limits`, replaces `prune-job-events` and
`prune-tts-usage`.

It:

- expires reserved/active admissions whose leases elapsed and releases their
  active gauges exactly once;
- deletes terminal admissions after the longest relevant idempotency window;
- deletes usage events after the longest configured usage window plus a safety
  margin;
- deletes fixed-window buckets after their window and idempotency margin pass;
- repairs active gauges from live, unexpired admissions when inconsistency is
  detected;
- reports counts by category without identifiers.

Account export includes sanitized user-scoped admission and usage history. It
does not export site/IP/device bucket identities. User deletion relies on FK
cascades for admissions and usage events and explicitly removes the user's
bucket rows; shared expiring device/IP/site buckets remain retention-owned.

Because existing usage is intentionally reset, the database migration does not
copy `user_tts_chars` or `user_job_events` rows.

---

## Database Migration and Hard Cut

Create matching next-numbered PostgreSQL and SQLite migrations that:

1. Create `compute_limit_admissions`, `compute_limit_buckets`, and
   `compute_limit_events` with the constraints and indexes above.
2. Write the new `computeLimitPolicies` admin setting from existing limiter
   configuration, using dialect-specific JSON construction where necessary.
3. Delete the superseded limiter setting rows after the new policy row exists.
4. Delete old scheduled-task state for `prune-job-events` and
   `prune-tts-usage`.
5. Drop `user_tts_chars` and `user_job_events` without copying their rows.

The final code must then delete:

- old schema exports for both tables;
- `rate-limiter.ts`, `job-rate-limiter.ts`, and whole-plan playback quota code;
- old problem-response builders that no longer own a caller;
- the two old pruning handlers and registry entries;
- old explicit user-cleanup table deletes;
- old account-export queries and response fields;
- old TTS/PDF runtime keys, client runtime fields, and admin controls;
- the old status route, query keys, contexts, and obsolete UI wording;
- old environment examples and current docs;
- tests that preserve old implementation details.

Do not retain aliases, dual writes, views, compatibility routes, or empty legacy
tables. Preserve released v4 administrator configuration through the one-time
migration, but intentionally reset usage as approved for this v5 rollout.

---

## Efficient Implementation Sequence

The PR should proceed in vertical slices that keep compile failures local while
ending in one hard cut.

### Step 1: Contract and policy resolver

- Define `ComputeAction`, validated policy types, defaults, and cross-field
  validation.
- Add `computeLimitPolicies` to server/client runtime config.
- Add exhaustive compile-time tests covering all worker operation kinds.
- Update runtime seed parsing/full-payload tests immediately so later settings
  work has one contract.

Acceptance:

- Invalid documents and unknown actions fail atomically.
- Every action resolves a complete policy.
- Seed JSON can express every Admin field.

### Step 2: SQL engine and migration

- Add the three schemas and dialect migrations.
- Implement transactional admission, activation, finish, usage consume, status,
  and prune operations.
- Test SQLite and PostgreSQL behavior where the suite supports both.
- Add concurrency tests that race at the boundary.

Acceptance:

- Duplicate request/event keys do not double increment.
- Strict counters never cross their caps.
- A soft TTS counter allows exactly one atomic crossing unit.
- Multi-scope failure rolls back every bucket.
- Finish, duplicate finish, and expiry release active gauges exactly once.

### Step 3: App admission coordinator and all creation paths

- Add one shared create/resolve/admit/activate wrapper.
- Wire PDF layout, playback plans, playback sessions, document previews, DOCX
  conversion, TTS export assembly, and account export.
- Add worker `created`/`reused` disposition.
- Add typed problem responses and the generic status read model.

Acceptance:

- Every operation kind has an integration test for enabled, disabled, denied,
  reused, worker-failed, and active-limit behavior as applicable.
- Reused artifacts and operations do not consume active capacity.
- Preview denial does not fail upload.

### Step 4: Segment-level TTS consumption

- Store the playback admission id in the canonical worker session.
- Add authenticated broker consumption and terminal/lease callbacks.
- Remove session/export whole-plan charging.
- Consume only after cache miss and segment lease acquisition.
- Propagate typed quota exhaustion through operation/session SSE and player UI.

Acceptance:

- Abandoned preparation costs zero characters.
- A cache hit costs zero.
- One generated segment costs its normalized text length once.
- Worker redelivery and provider retry do not double-charge.
- Cache epoch reset permits a new charge for regenerated audio.
- The crossing segment completes; the next uncached segment is denied.
- Cached audio remains usable after exhaustion.
- Denial writes no permanent error sidecar and causes no retry spin.

### Step 5: Worker scheduler and provider limits

- Replace all per-family gates with the priority/resource scheduler.
- Acquire capacity before pulling work.
- Add queue bounds, queue age, diagnostics, and policy refresh.
- Add distributed per-provider rate/concurrency coordination and 429 cooldown.
- Remove `COMPUTE_JOB_CONCURRENCY`; derive the ONNX thread budget from the
  policy-owned worker limit.

Acceptance:

- Total executing work never exceeds the worker-wide setting.
- Per-kind and resource limits hold under mixed concurrent queues.
- Live TTS wins prompt capacity without permanently starving background work.
- No message waits behind a gate without ack management.
- Two worker instances together obey one provider override.
- Pause/seek aborts a provider-capacity wait promptly.

### Step 6: Admin UI, seed, cleanup, and documentation

- Finish the complete Admin editor and source/reset behavior.
- Update `.env.example`, seed examples, current docs, and deployment references.
- Replace pruning, account export, user cleanup, query keys, and client context.
- Drop old tables/settings and delete every old implementation path.
- Run a reachability and terminology audit for old limiter names.

Acceptance:

- An admin can edit every action, worker, queue, resource, and provider limit.
- Every Admin-editable value can be supplied by runtime seed JSON.
- Admin changes reach the worker within the configured refresh interval.
- `rg` finds no production reference to the dropped tables, old runtime keys,
  old task ids, or misleading PDF-concurrency wording.

### Step 7: Full validation

Run:

- focused unit and integration tests while implementing;
- `pnpm test`;
- `pnpm exec tsc --noEmit`;
- `pnpm --dir packages/compute-worker exec tsc --noEmit`;
- `pnpm lint:route-errors`;
- `pnpm check:compute-boundary`;
- `pnpm build`;
- complete Chromium/WebKit `pnpm test:e2e` after confirming port 3003 is free.

Add the smallest Playwright coverage for Admin policy editing/validation and the
user-visible TTS exhaustion transition. True provider generation remains in the
existing consolidated real-playback journey.

---

## Required Test Matrix

### Policy and configuration

- Defaults resolve every action and resource.
- Admin and seed values share the same validator.
- Unknown keys, impossible resource requests, invalid scopes, and invalid
  thresholds fail before writes.
- Source/reset behavior is preserved.
- Worker rejects an invalid broker policy and retains the last valid version.

### SQL concurrency

- Many concurrent strict admissions cannot exceed the cap.
- Many concurrent soft consumes allow only the first crossing segment.
- Duplicate idempotency keys across concurrent transactions charge once.
- User/device/IP/site bucket rollback is atomic.
- Expiry racing terminal completion decrements active once.

### Operation lifecycle

- New, reused, failed-create, succeeded, failed, cancelled, superseded, stale,
  and redelivered operations settle admissions correctly.
- Automatic preview deferral is recoverable.
- Worker callback outage is repaired by expiry/reconciliation.

### TTS

- Live ahead-window generation is charged per actual missing segment, not plan.
- Whole-document export uses the same metering.
- Cache hits, sidecar repair, exact alignment, pause-before-call, and abandoned
  prepare are free.
- Retry is idempotent; cache epoch invalidation permits regeneration charge.
- User, anonymous device, and IP thresholds can each be binding.
- The client distinguishes quota waiting from playing and from upstream failure.

### Scheduling and providers

- Mixed action load obeys worker total, per-kind, and resource limits.
- Priority aging prevents starvation.
- Queue-full and queue-expired errors include correct retry metadata.
- Multi-replica provider request, character, and concurrency limits hold.
- Upstream `Retry-After` creates shared cooldown without charging usage twice.

---

## Completion Criteria

The work is complete only when:

1. Every compute operation and TTS synthesis has an explicit validated policy.
2. Every limiting area is editable in Admin Settings and seedable through JSON.
3. TTS charges only actual uncached segments with the approved soft threshold.
4. Admission, active, usage, queue, worker, resource, and provider limits have
   their correct owners and concurrency tests.
5. The worker has no SQL dependency and no raw user backstop identifiers.
6. The old tables, settings, routes, tasks, exports, modules, tests, and active
   documentation are gone.
7. Existing usage is intentionally reset and existing admin configuration is
   represented by the new policy document.
8. Full application, worker, build, boundary, and browser validation passes.
9. Port 3003 is free after the test run and no task-owned stack remains running.

---

## Implementation History

- The unified policy, SQL admission/usage engine, worker scheduler, distributed
  provider coordination, Admin controls, seed, migrations, and legacy cleanup
  were implemented together on `feat/unified-compute-limits`.
- Final acceptance evidence belongs in the PR description and release history;
  this document remains the normative architectural and behavioral contract.
