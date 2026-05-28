# Server Error Contract

This module is the centralized server error contract for API routes, background jobs, and server libraries.

## Canonical Shapes

- App error contract: `ServerAppError` in `contract.ts`
- Normalization entrypoint: `normalizeServerError(error, ctx?)`
- API response mapping: `toApiErrorBody(...)` + `toHttpStatus(...)`
- Log helpers: `logServerError(...)` and `logDegraded(...)`

## Classification Policy

`ServerErrorClass` defaults:

- `validation` -> `400`, `retryable=false`
- `auth` -> `401`, `retryable=false`
- `permission` -> `403`, `retryable=false`
- `upstream` -> `502`, `retryable=true`
- `storage` -> `503`, `retryable=true`
- `db` -> `500`, `retryable=true`
- `timeout` -> `504`, `retryable=true`
- `unknown` -> `500`, `retryable=false`

## Code Naming

App error codes use low-cardinality uppercase snake case: `DOMAIN_ACTION_REASON`.

Examples:

- `AUDIOBOOK_CHAPTER_PROCESS_FAILED`
- `DOCUMENT_PREVIEW_GENERATE_FAILED`
- `USER_EXPORT_AUTH_NOT_INITIALIZED`
- `UNKNOWN_SERVER_ERROR`

## Route Contract

Terminal route failures should use `errorResponse(...)` from `next-response.ts`.

Response body shape:

- `error`
- optional `errorCode`
- optional `retryable`
- optional safe `details`

## Logging Contract

Failure logs:

- `event`
- `msg`
- nested `error` (from `errorToLog(...)`)
- optional `error.code` for app classification

Degraded warnings:

- `degraded: true`
- `step` or `fallbackPath`
- `event` + `msg`
