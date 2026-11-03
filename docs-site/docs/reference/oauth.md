---
title: OAuth clients
description: Connect third-party clients to an OpenReader instance with scoped OAuth access.
---

OpenReader supports authorization code with S256 PKCE, rotating refresh tokens,
and device authorization. Users approve apps in their signed-in browser. Guest,
pending, suspended and deletion-pending accounts cannot approve access.

## Discover the instance

Use the instance's configured public `BASE_URL`, with HTTPS outside local
development. The exact resource identifier is **`BASE_URL/api/v1`**, without a
trailing slash. Request it explicitly in authorization, device-code and token
requests. [MCP](./mcp) has its own resource, **`BASE_URL/api/mcp`**. A token works
only on the resource the user approved it for, and a refresh token stays on it.
Device authorization is available for `BASE_URL/api/v1` only.

| Discovery | URL relative to the instance origin |
| --- | --- |
| Protected resource | `/.well-known/oauth-protected-resource/api/v1` |
| MCP protected resource | `/.well-known/oauth-protected-resource/api/mcp` |
| Authorization server | `/.well-known/oauth-authorization-server/api/auth` |
| API specification | `/api/v1/openapi.json` |

The issuer is `BASE_URL/api/auth`. Read endpoints and supported features from its
metadata rather than constructing them. An unauthenticated v1 response includes
a `WWW-Authenticate` challenge pointing to protected-resource metadata. Signing
keys are available at the discovered `jwks_uri`; private keys stay on the server.

`BASE_URL` must be the address clients reach the instance at: it is compared
exactly against the issuer and token audience. Changing it, or a desktop app
starting on a different port, changes both, so clients must rediscover the
instance and reconnect. Keep `AUTH_SECRET` stable: it protects existing account
data, signing keys and authorization requests. No separate OAuth secret is needed.

## Register a client

A client either registers dynamically or uses a client ID metadata document. Both
are open by default. Administrators can disable both with **Open OAuth client
registration** in **Settings → Admin → Instance**. This stops new clients; it does
not disconnect existing apps. The setting is also named
`allowOAuthClientRegistration` in a runtime seed. There is no separate
client-management API. A client that no user has approved is removed 30 days after
it registers.

For a native public client, POST JSON to the discovered `registration_endpoint`:

```json
{
  "client_name": "My reader tool",
  "application_type": "native",
  "redirect_uris": ["http://127.0.0.1:43210/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  "response_types": ["code"],
  "scope": "documents:read offline_access",
  "resources": ["https://reader.example/api/v1"]
}
```

Replace the example resource with the discovered resource. Register the exact
redirect URI, including the port and path. Native clients can use loopback HTTP
redirects; web clients use HTTPS redirects. Public clients must not invent a
client secret. Confidential clients must use their registered authentication
method and keep their secret out of browsers and source control.

Instead of registering, a client can use the HTTPS URL of a client ID metadata
document, up to 512 characters, as its `client_id`. OpenReader fetches the document
when the client first connects, and the authorization server metadata reports
`client_id_metadata_document_supported`.

Neither way grants library access. Consent and Connected apps show the domain of a
metadata document client, because that domain controls its client ID. Names are
self-reported, so a dynamically registered client is labeled **Unverified app**.
Users should check the destination and approve only the app they intended to use. A custom
redirect scheme is shown in full (`myapp://callback`), because anyone can register
one that names another site's host. Device approval has no redirect, so it shows no
destination. Registration limits names to 200 characters, URLs to 2048 characters
and `redirect_uris` to 20 entries; larger values return `invalid_client_metadata`.

## Scopes

| Scope | Access |
| --- | --- |
| `documents:read` | Read identity/limits, documents, folders, speech providers, voices and audiobook status/files |
| `documents:write` | Create, upload, rename, move and delete owned documents and folders |
| `audio:generate` | Start and stop audiobook generation |
| `offline_access` | Obtain a refresh token so access can continue without a browser login |

Scopes do not imply one another. Request `documents:read` along with
`audio:generate` to read the resulting audiobook; that combination also lets
status reads advance it. With `documents:read` alone, reads never start work. No
scope grants admin, provider
configuration, account management, live reader streaming or worker access. All
library operations remain limited to the approving user's resources.

## Authorization code with PKCE

1. Generate a fresh random state and PKCE verifier. Compute its SHA-256 base64url
   challenge. Open the discovered authorization endpoint in the user's browser
   with `response_type=code`, `client_id`, the exact `redirect_uri`, `scope`,
   `resource`, `state`, `code_challenge` and `code_challenge_method=S256`.
2. The user signs in and approves the displayed app, destination and scopes, under
   the account shown, and can switch account first.
   Denial returns an OAuth error to the registered redirect.
3. At the callback, validate state before accepting the code. Exchange it at the
   token endpoint with form encoding: `grant_type=authorization_code`,
   `client_id`, `code`, the same `redirect_uri`, `code_verifier` and `resource`.
   Authenticate a confidential client using its registered method.
4. Keep tokens private. Use the access token in the Authorization header on v1
   requests. Never place access or refresh tokens in resource URLs.

Access tokens last 15 minutes. With `offline_access`, refresh using form-encoded
`grant_type=refresh_token`, `client_id`, `refresh_token` and `resource`, plus any
registered client authentication. **Store the replacement refresh token
atomically and stop using the old one.** Refresh tokens rotate with no reuse
window and have a 30-day lifetime. Serialize refreshes per grant.

## Device authorization

POST form-encoded `client_id`, `scope` and `resource` to the discovered
`device_authorization_endpoint`. Present its `user_code` and verification URL to
the user. The user signs in, checks the code and explicitly allows or denies it. A
`verification_uri_complete` link fills in the code and shows the request directly.
Only approve a code displayed by a device you are using; an unexpected code sent
by someone else can authorize that person's device.

Poll the **OAuth token endpoint** using
`grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`,
`device_code` and `resource`, with registered client authentication if needed.
Honor `interval`, `authorization_pending`, `slow_down` and expiry; stop on denial
or expiry. `/api/auth/device/token` is intentionally disabled: OAuth clients
receive scoped tokens, never browser sessions.

## Disconnect and failures

In **Settings → Account → Connected apps**, Disconnect deletes that user's
consent, refresh credentials and approved pending device codes for the app.
Already-issued JWTs stop working immediately because every API request checks
the current grant, account and client. Reconnecting creates a new grant; it does
not revive old access or refresh tokens. Signing out of the browser does not
disconnect an app with offline access.

Clients can submit refresh tokens to the discovered revocation endpoint. JWT
access-token revocation there is unsupported; Disconnect is the way to revoke
the entire app grant immediately. A revoked or invalid bearer token returns
`401 INVALID_TOKEN`; a valid token missing a required scope returns
`403 INSUFFICIENT_SCOPE` with that scope in `WWW-Authenticate`. An attached cookie
does not override either result. Existing user compute limits still apply and
can return `429` with `Retry-After`.

OAuth does not enable general browser CORS or add extension origins to trusted
origins. Browser extensions use their host permissions; server and native clients
send bearer requests directly. The web app continues using its existing cookie
and same-origin protections.

## Self-hosted upgrade

The public API adds migration **0027_public_api** for SQLite and PostgreSQL. It adds
the audiobook request, OAuth, device, signing-key and audio usage tables without
replacing existing users, sessions or provider ciphertext. It also clears stored raw
session IP addresses and removes retired IP and device limit records. Back up the
database and apply it through the instance's normal upgrade procedure
before starting the new web version. Update the web app and an external compute
worker together. The worker does not need OAuth credentials or database access.
