# V5 User Management and Administrator Bootstrap

## Ownership and directory

Next.js owns **Settings → Admin → Users** and all account mutations. The
compute worker never reads the user or authorization tables. The paginated,
server-filtered directory includes registered and anonymous accounts, status,
admin grant source, verification, creation and last session activity, document
count and owned bytes, and metered compute events. Compute totals are not a
complete historical billing ledger: an action records usage only when its
corresponding policy enables metering.

Admins can approve pending accounts, suspend or restore accounts, grant or
revoke managed admin access, and delete another user after user-scoped storage
cleanup succeeds. Role and status changes revoke sessions. The final active
admin, self-demotion, self-suspension, and self-deletion are blocked. A failed
storage cleanup retains the account and ownership rows.

`signupPolicy` is one runtime setting, optionally seeded by
`runtimeConfig.signupPolicy` in the version 1 runtime JSON document:

- `open`: registered accounts become active immediately.
- `approval`: new registered accounts are pending and cannot create a session
  until approved. Anonymous sessions still require their separate deployment
  opt-in.
- `closed`: new registered accounts are refused; existing accounts can sign in.

The migration maps an existing `enableUserSignups` database value to `open` or
`closed`, gives existing users active status, and preserves existing admin
flags as managed grants. Approval is not proof of email ownership. An operator
relying on email identity should enable account email verification and check
that state before approval, or verify identity out of band.

## One-time first administrator

`ADMIN_EMAILS` has been removed. An email address alone never grants authority,
and changing an administrator's address does not change their role.

On a fresh installation, the operator supplies `BOOTSTRAP_ADMIN_EMAIL` and
exactly one of `BOOTSTRAP_ADMIN_PASSWORD` or `BOOTSTRAP_ADMIN_PASSWORD_FILE`.
The password must contain at least 16 characters. OpenReader creates a
credential account and a durable `initialAdminBootstrapped` marker in one
database transaction. The initial account is active but not yet an admin.
The operator signs in and changes the initial password in **Settings →
Account**. The credential update activates a managed administrator grant and
revokes other sessions. Account email delivery, when enabled, additionally
requires address verification before the initial sign-in.

The marker prevents replay across processes, restarts, and deletion of the
initial account. An existing administrator prevents seeding; migration also
marks upgraded installations as bootstrapped. A configured email already
owned by another account is rejected rather than promoted. The first-admin
credential bypasses public signup and approval policy because it is created
server-side, not through the registration route. After rotation, the initial
password is invalid and no env edit or restart is required. Removing the
seed values later is optional secret hygiene. Later administrators are granted
by an existing admin in Users.

Losing the last admin requires explicit operator database recovery; there is
no public fallback or permanent environment email allowlist. Keep bootstrap
passwords out of logs, source control, seed JSON, and browser-visible runtime
configuration. For containers, a mounted secret file is preferable to a
long-lived inline password.

## Account self-service

Registered users can edit their display name and change a known password in
**Settings → Account**. Password changes revoke other sessions. When account
email delivery is enabled, the tab also lets users resend current-address
verification or request a new address. The change completes only after the
new inbox verifies it. Without account email delivery, verification and email
change are unavailable; password change remains available.
