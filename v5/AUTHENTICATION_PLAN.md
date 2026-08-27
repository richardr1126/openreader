# V5 Authentication and Credential-Broker Plan

## Decision

OpenReader v5 will remove all application-database access from the compute
worker. The Next.js application remains the only owner of users, sessions,
admin configuration, and encrypted TTS provider credentials. When a worker
begins a TTS generation job, it resolves the requested provider through one
authenticated credential-broker endpoint owned by the application.

This is a hard architectural cut, not a compatibility layer:

- one app-owned provider resolver;
- one worker-to-app credential-broker contract;
- no worker database resolver or database fallback;
- no provider credentials in NATS jobs, operation state, events, logs, or
  artifacts;
- no `POSTGRES_URL`, SQLite database path, or `AUTH_SECRET` in the standalone
  worker environment;
- no `@openreader/database` or `drizzle-orm` dependency in the compute-worker
  package after the migration.

The current v4 storage contract remains intact: provider credentials already
stored in the database continue to be encrypted and decrypted by the app using
`AUTH_SECRET`. V5 has not shipped, so no released worker-database contract must
be preserved. Moving provider encryption to a second at-rest key would require
a migration for existing v4 installations and is not part of this plan.

Implementation history and acceptance evidence should be recorded at the end
of this document as each phase lands.

---

## Goals

1. Make SQL and authentication state exclusively app-owned.
2. Remove `AUTH_SECRET` and application database credentials from the compute
   worker.
3. Resolve TTS provider configuration at job execution time without persisting
   plaintext or encrypted provider secrets in the worker queue.
4. Preserve existing v4 provider ciphertext without a re-encryption migration.
5. Keep browser, app-server, and worker authentication mechanisms distinct and
   explicit.
6. Fail closed when the broker is unavailable, unauthenticated, or unable to
   resolve an enabled provider.
7. Delete the superseded worker resolver, dependencies, configuration, tests,
   and documentation in the same change that adopts the broker.
8. Prove the full and slim deployment topologies work from fresh volumes and
   across an upgrade containing existing encrypted provider records.

## Non-Goals

- Do not send provider credentials in a NATS job, even as an encrypted blob.
- Do not add a worker database role or grant the worker read-only SQL access.
- Do not retain a worker database fallback for mixed v5 revisions.
- Do not proxy all TTS synthesis through Next.js; the worker continues calling
  configured TTS providers directly.
- Do not invent application-layer encryption on top of HTTPS. Transport
  encryption and authenticated endpoints own in-transit protection.
- Do not change browser playback-token semantics as part of the broker cut.
- Do not split public audio and private control routes onto separate listeners
  in this plan.
- Do not change the accepted `ADMIN_EMAILS` promotion policy in this plan.
- Do not introduce a second provider-at-rest encryption key without a complete
  v4 data migration design.

---

## Authentication Boundaries

V5 has four explicit request boundaries. A credential valid at one boundary
must not be reused by a browser at another boundary.

| Boundary | Authentication | Authorization purpose |
| --- | --- | --- |
| Browser to Next.js | Better Auth session/cookie | User identity, document ownership, admin access, quota decisions |
| Next.js to compute worker | `COMPUTE_WORKER_TOKEN` bearer token | Create, inspect, update, and clean up worker operations |
| Browser to worker audio | Short-lived `TTS_PLAYBACK_TOKEN_SECRET` HMAC token | Read one playback session scoped to one user and document |
| Compute worker to Next.js broker | `COMPUTE_CREDENTIAL_BROKER_TOKEN` bearer token | Resolve one enabled TTS provider for execution |

The compute-worker bearer token and credential-broker bearer token are
deliberately separate. The direction, receiving service, and permitted actions
are different. Neither token is ever returned to the browser.

### Browser to Next.js

Next.js remains the authenticated control plane. Before creating a worker
operation, it must continue to:

- resolve the Better Auth session;
- authorize access to the requested document and storage user;
- validate playback settings and provider selection;
- apply signup, admin, feature, and quota policy;
- construct canonical operation and playback identities.

The broker does not replace user authorization. It is reachable only after a
job has already been accepted through an app-authorized path.

### Next.js to compute worker

`COMPUTE_WORKER_TOKEN` continues protecting every worker control route except
health checks and the intentionally browser-reachable playback audio route.
The app sends this token only in the `Authorization` header.

The token must never appear in:

- browser responses;
- playback URLs;
- operation bodies;
- NATS payloads;
- application or worker logs.

### Browser to worker audio

Direct browser-to-worker playback remains intentional. Next.js creates a
short-lived HMAC token containing the canonical playback session, user,
storage-user, document, and expiry scope. The worker verifies the signature,
expiry, URL session identifier, and stored session scope before returning
audio.

The public audio token is not a worker-control credential and cannot create,
resolve, cancel, or clean up operations.

### Compute worker to credential broker

The worker uses a dedicated broker token when it needs an enabled provider for
actual synthesis. The broker token proves that the caller is a trusted worker;
it does not grant admin UI access, user-session access, or general-purpose API
access.

The initial v5 contract permits a trusted worker to resolve an enabled
provider by reference. Per-operation signed grants are intentionally deferred:
the worker is already trusted to execute the queued provider request, and a
grant system would add expiry and replay state without removing the worker's
need to hold the provider credential during synthesis.

---

## Current Problem

The worker currently imports the application database and duplicates provider
lookup and `AUTH_SECRET`-based decryption logic. This creates several problems:

1. Standalone workers silently fall back to their own SQLite database when
   `POSTGRES_URL` is absent.
2. Full Compose therefore queries an unmigrated database and fails with errors
   such as `no such table: admin_providers`.
3. Supplying Postgres to the worker would expose the wider application database
   even though the worker needs only provider execution configuration.
4. Supplying `AUTH_SECRET` to the worker expands the impact of a worker-secret
   compromise into the application authentication boundary.
5. Provider-selection and decryption behavior exists in both the Next.js and
   compute-worker packages and can drift.

The worker has no other source-level application-database usage. Removing its
provider resolver eliminates the worker's reason to depend on SQL entirely.

---

## Target Flow

```text
Browser
  |
  | Better Auth session + playback request
  v
Next.js application
  |-- authorize user and document
  |-- persist/resolve provider configuration in app database
  |-- queue providerRef only
  v
NATS operation/job
  |  contains no provider credential
  v
Compute worker begins generation
  |
  | POST broker request with providerRef
  | Authorization: Bearer COMPUTE_CREDENTIAL_BROKER_TOKEN
  v
Next.js credential broker
  |-- authenticate worker
  |-- resolve enabled provider through the canonical app resolver
  |-- decrypt existing v4-compatible ciphertext with AUTH_SECRET
  |-- return execution configuration with Cache-Control: no-store
  v
Compute worker memory
  |-- use configuration for the current generation job only
  |-- call upstream TTS provider
  `-- release references when the job ends
```

The app returns the credential only when the worker needs it. The job queue
contains the stable provider reference and settings identity, preserving
operation reuse without turning NATS into a secret store.

---

## Credential-Broker Contract

### Route

The canonical route is:

```text
POST /api/internal/compute/tts-credentials
```

It is an internal service endpoint even when the hosting platform makes the
Next.js origin publicly routable. Its bearer authentication is mandatory in
all environments, including local development and tests.

### Request

```json
{
  "providerRef": "kokoro"
}
```

Rules:

- reject a missing or malformed bearer token before reading provider data;
- require one normalized provider reference;
- impose the normal small JSON request-size limit;
- do not accept SQL identifiers, arbitrary filters, encrypted values, or API
  keys from the worker;
- do not use user-controlled provider defaults that were not already captured
  in the authorized operation settings.

### Successful response

```json
{
  "providerRef": "kokoro",
  "providerType": "custom-openai",
  "apiKey": "...",
  "baseUrl": "http://kokoro-tts:8880/v1",
  "defaultModel": "kokoro",
  "defaultInstructions": null
}
```

The response contains only the execution configuration already required by the
worker. It must set:

```text
Cache-Control: no-store, private
Pragma: no-cache
```

No response value may be placed in an error message or structured log.

### Error responses

| Condition | Status | Stable error code |
| --- | ---: | --- |
| Missing or invalid broker token | `401` | `BROKER_UNAUTHORIZED` |
| Malformed provider reference | `400` | `PROVIDER_REF_INVALID` |
| Unknown or disabled provider | `404` | `PROVIDER_UNAVAILABLE` |
| Provider ciphertext cannot be decrypted | `500` | `PROVIDER_DECRYPT_FAILED` |
| Database or application dependency unavailable | `503` | `BROKER_UNAVAILABLE` |

Worker logs may record the stable code, provider-reference hash, operation ID,
and retry decision. They must not record response bodies, authorization
headers, base URLs containing credentials, or API keys.

### Transport

- Remote app/worker deployments must use HTTPS for
  `COMPUTE_CREDENTIAL_BROKER_URL`.
- Full Compose may use `http://openreader:3003` on its private Compose network.
- The broker must not be addressed through the browser-facing compute-worker
  URL.
- TLS certificate validation must not be disabled.
- Custom AES/RSA envelope code is not added. The worker necessarily receives
  plaintext in memory, so application-layer re-encryption would not protect a
  compromised worker and would introduce another long-lived decryption key.

---

## Configuration Contract

### Next.js application

The app retains:

```env
AUTH_SECRET=...
COMPUTE_WORKER_TOKEN=...
COMPUTE_CREDENTIAL_BROKER_TOKEN=...
TTS_PLAYBACK_TOKEN_SECRET=...
POSTGRES_URL=... # or app-owned SQLite
```

`AUTH_SECRET` continues decrypting provider records created by v4. It is never
sent by the broker and is no longer provided to the worker.

### Standalone compute worker

The worker receives:

```env
COMPUTE_WORKER_TOKEN=...
COMPUTE_CREDENTIAL_BROKER_URL=https://openreader.example.com/api/internal/compute/tts-credentials
COMPUTE_CREDENTIAL_BROKER_TOKEN=...
TTS_PLAYBACK_TOKEN_SECRET=...
NATS_URL=...
S3_*=...
```

The worker must not receive:

```env
AUTH_SECRET
POSTGRES_URL
SQLITE_DB_PATH
```

### Embedded worker

Bootstrap supplies the embedded worker child process with the local broker URL
and broker token. The endpoint may not be reachable during initial process
startup, but no credential is requested until an authenticated playback job is
executed after the Next.js server is ready.

There is no in-process shortcut. Embedded and standalone workers use the same
broker client and contract so only one production credential path exists.

---

## Runtime Rules

### Resolve once per generation job

The worker resolves credentials once when a generation job reaches actual
synthesis. It reuses that in-memory object for the segments generated by that
job and releases it when the handler finishes.

V5 must not add a process-global provider cache. Resolving once per job keeps
network overhead small while ensuring provider edits and disabling take effect
on the next job.

### Fail closed

If broker resolution fails, the worker must not:

- fall back to its environment;
- open SQLite;
- query Postgres;
- choose an arbitrary built-in provider;
- reuse credentials from a prior completed job;
- persist a credential so a retry can continue without the broker.

Transient network and `503` errors may follow the existing bounded job retry
policy. Authentication, malformed request, missing provider, and decryption
errors are terminal until configuration changes.

### Preserve identity and caching

Provider credentials are not part of audio cache identity. Existing stable
identity remains based on the provider reference, effective provider/model
settings, document/version, text, and playback settings. The broker response
must not be added to operation keys or serialized settings.

### No secret observability

Redaction tests must cover:

- app request logs;
- worker HTTP error handling;
- NATS queued jobs and operation state;
- SSE operation events;
- playback sidecars and plans;
- generated OpenAPI examples;
- browser responses other than the signed audio URL already intended for the
  browser.

---

## Implementation Phases

### Phase 0: Lock the boundary with tests

Status: pending.

Before changing runtime ownership, add focused assertions for the intended hard
cut:

- the broker rejects missing and invalid authentication;
- existing app-side provider resolution selects enabled providers and decrypts
  v4 records;
- queued playback requests contain provider references but no provider API key;
- compute-worker source outside test fixtures has no allowed long-term database
  boundary.

Gate:

- tests describe the target ownership without requiring the old worker resolver
  to remain after the migration;
- fixtures use unmistakably synthetic secrets and assert they do not leak.

### Phase 1: Add the app-owned broker

Status: pending.

1. Extract or reuse one canonical app-owned provider-execution resolver.
2. Add the authenticated internal broker route.
3. Add strict request and response schemas.
4. Add stable error codes and secret-safe logging.
5. Set no-store response headers.
6. Add route tests for authentication, enabled/disabled providers, default
   selection, v4 ciphertext decryption, and degraded database behavior.

Gate:

- no provider query or decryption logic is copied into the route;
- the route delegates to the canonical app resolver;
- no unauthenticated response distinguishes unknown from configured providers;
- tests prove headers and response bodies are not logged.

### Phase 2: Move worker execution to the broker

Status: pending.

1. Add a small worker broker client with bounded timeout and abort support.
2. Resolve the provider immediately before segment synthesis.
3. Map stable broker error codes into terminal or retryable worker errors.
4. Keep credentials local to the current handler invocation.
5. Test successful resolution, timeout, authentication failure, disabled
   providers, retry behavior, abort behavior, and secret redaction.

Gate:

- real generation uses only broker-supplied execution configuration;
- retries never serialize the credential;
- provider edits apply to the next generation job;
- an unavailable broker produces an actionable job error rather than a silent
  fallback.

### Phase 3: Delete worker database ownership

Status: pending.

Delete in the same change:

- `packages/compute-worker/src/jobs/tts-credentials.ts`;
- worker imports of `@openreader/database` and Drizzle;
- `@openreader/database` and `drizzle-orm` from the worker package manifest when
  no remaining reference exists;
- worker-side `AUTH_SECRET`, `POSTGRES_URL`, and `SQLITE_DB_PATH` documentation;
- worker tests that exercise its deleted SQL/decryption implementation;
- architecture exceptions that describe provider SQL as worker-readable.

Do not leave a deprecated wrapper, environment fallback, feature flag, or dual
resolver. The broker client becomes the only production implementation.

Gate:

- repository search finds no database package import under worker source;
- the worker image contains no application database package solely through a
  direct worker dependency;
- worker startup and non-TTS jobs require no app database variables;
- compute-boundary tests reject future worker database imports.

### Phase 4: Wire every deployment topology

Status: pending.

Update:

- embedded development and production bootstrap;
- slim and local-slim Compose examples;
- full and local-full Compose examples;
- standalone worker environment template;
- Railway/Vercel deployment examples;
- active environment-variable reference.

Full Compose points the worker broker URL at the internal app service and no
longer gives the worker Postgres access. Public deployments use an HTTPS app
origin. Local examples may retain clearly documented local-only token defaults;
the Compose guide must continue warning users to replace them outside a trusted
local network.

Gate:

- configuration has one documented owner per variable;
- the app and worker share only the tokens required by their explicit
  boundaries;
- full Compose contains no worker `POSTGRES_URL` or `AUTH_SECRET`;
- browser-facing URLs contain neither broker nor worker-control tokens.

### Phase 5: Fresh-stack and upgrade verification

Status: pending.

Use fresh volumes for the first pass, then verify an upgrade-shaped database
containing a v4-encrypted shared provider.

Required journeys:

1. Slim fresh stack seeds its provider and produces playback.
2. Full fresh stack seeds its provider and produces playback without worker SQL
   access.
3. Local-full fresh stack behaves the same using locally built images.
4. A v4 provider record encrypted with the existing `AUTH_SECRET` remains
   usable after starting v5.
5. Disabling a provider in the admin UI causes the next job to fail closed.
6. Editing a provider causes the next job to use the new configuration without
   restarting the worker.
7. Invalid broker authentication produces no credential response and no secret
   log entry.

Browser verification must follow the repository's browser-first testing rule:
observe playback through the visible application before updating or adding the
smallest Playwright coverage. Deterministic protocol, redaction, and failure
semantics belong in Vitest.

Gate:

- all required journeys pass;
- Vitest, types, lint, build, OpenAPI, compute-boundary, and relevant Playwright
  checks pass;
- the full Compose `admin_providers` failure cannot recur because the worker no
  longer opens an application database;
- running services are left in the state explicitly requested for the test
  session, without duplicate Compose or Playwright-owned stacks.

### Phase 6: Documentation and final audit

Status: pending.

Update active documentation to explain:

- the four authentication boundaries;
- the difference between control, broker, and playback tokens;
- why `AUTH_SECRET` remains app-only;
- required HTTPS for a remote broker;
- local-only Compose defaults;
- deployment and rotation procedures;
- broker failure troubleshooting without logging secrets.

Update other v5 architecture documents that currently describe narrow worker
SQL access. Do not rewrite frozen, versioned v4 documentation to describe v5.

Final audit searches for:

- worker database imports;
- worker `AUTH_SECRET`, `POSTGRES_URL`, and `SQLITE_DB_PATH` references;
- duplicate provider resolution/decryption implementations;
- provider API keys in queue and operation types;
- broker or control tokens in client bundles and responses;
- active documentation that teaches the retired worker-database path.

Gate:

- code, generated contracts, tests, Compose examples, environment templates,
  and active docs describe the same architecture;
- no compatibility implementation remains for an unreleased v5 path;
- completed work and verification evidence are recorded below.

---

## Required Test Inventory

### App broker tests

- accepts the exact configured broker bearer token;
- rejects missing, malformed, and incorrect bearer tokens;
- rejects invalid provider references;
- resolves an enabled provider by slug;
- preserves current preferred-provider selection when a built-in reference is
  used;
- rejects disabled or missing providers without revealing credentials;
- decrypts a provider record produced by the v4 `AUTH_SECRET` contract;
- sends no-store headers;
- redacts API keys and authorization headers from success and failure logs.

### Worker broker-client tests

- sends only provider reference and broker authorization;
- parses the canonical execution configuration;
- propagates cancellation;
- applies bounded timeout and retry classification;
- treats `401`, invalid response schemas, and unavailable providers as closed
  failures;
- never includes response bodies in errors;
- holds credentials only in the current generation invocation.

### Boundary tests

- compute-worker source cannot import `@openreader/database`;
- worker manifests cannot depend directly on the database package or Drizzle;
- queued jobs, operation state, events, plans, and sidecars do not contain a
  sentinel API key;
- browser bundles and playback responses do not contain worker or broker
  bearer tokens;
- playback audio continues requiring a valid, scoped, unexpired HMAC token;
- worker control routes continue requiring `COMPUTE_WORKER_TOKEN`.

### Deployment tests

- embedded SQLite playback;
- standalone Postgres playback without worker DB variables;
- remote-style HTTPS broker URL configuration;
- provider edit and disable behavior across subsequent jobs;
- clean startup with new volumes;
- upgrade-shaped startup with an existing v4-encrypted provider.

---

## Secret Rotation

Each secret has a distinct operational effect:

| Secret | Rotation effect |
| --- | --- |
| `AUTH_SECRET` | Existing Better Auth sessions and stored provider ciphertext are affected under the existing v4 contract |
| `COMPUTE_WORKER_TOKEN` | App-to-worker control calls fail until app and worker agree |
| `COMPUTE_CREDENTIAL_BROKER_TOKEN` | Worker credential resolution fails until app and worker agree |
| `TTS_PLAYBACK_TOKEN_SECRET` | Existing signed playback URLs become invalid until new sessions issue new URLs |

For v5, rotation is coordinated configuration replacement followed by app and
worker restart. Dual-token acceptance is not added preemptively. If zero-downtime
rotation becomes a real deployment requirement, it should be designed as an
explicit multi-key contract rather than an undocumented comma-separated
fallback.

---

## Release Acceptance Criteria

The authentication migration is complete only when all of the following are
true:

- Next.js is the sole application-database owner.
- Next.js contains the sole provider lookup and at-rest decryption logic.
- Existing v4-encrypted provider records work without re-entry or re-encryption.
- Compute workers receive neither `AUTH_SECRET` nor application database
  credentials.
- Compute workers have no database or Drizzle dependency.
- Provider secrets exist only in the app during resolution, in the authenticated
  broker response in transit, in worker memory during execution, and at the
  upstream provider boundary.
- Provider secrets never enter NATS, operation state, SSE, storage artifacts,
  browser state, or logs.
- Full Compose playback works from new volumes without an `admin_providers`
  database error.
- Current control-route and signed-audio authorization behavior remains intact.
- Active documentation explains local defaults and remote HTTPS requirements.
- No old worker credential resolver, fallback, feature flag, or duplicate test
  remains.

---

## Completed Work

None yet. This document records the agreed v5 target before implementation.

## Remaining Work

All phases are pending. Begin with Phase 0 boundary tests, then implement the
broker and remove the old worker database path as one reviewed migration.
