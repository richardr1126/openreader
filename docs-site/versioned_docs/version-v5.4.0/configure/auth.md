---
title: Users and Sign-in
description: Sign-in methods, sign-up policy, guest sessions, account email, and managing users.
---

Every server install requires an account. This page covers how people sign in and how admins manage accounts. To create the first administrator, see [Administration](./admin-panel#create-the-first-administrator). The desktop app has a single owner who is signed in automatically, so none of this applies there.

## Required settings

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | The address people open in the browser, for example `https://reader.example.com`. |
| `AUTH_SECRET` | Signs sessions and encrypts saved keys. Generate it once with `openssl rand -base64 32` and [keep it stable](./admin-panel#how-saved-keys-are-protected). |
| `AUTH_TRUSTED_ORIGINS` | Optional. Other addresses allowed to sign in, comma-separated. Leave empty to trust only `BASE_URL`. |

## Sign-in methods

Email and password sign-in is always available. You can add single sign-on; each button appears on the sign-in page only when it is configured.

### GitHub

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Register `<BASE_URL>/api/auth/callback/github` as the callback URL in your GitHub OAuth app.

### OpenID Connect

For a self-hosted identity provider such as Pocket ID, Authelia, Authentik or Keycloak:

```dotenv
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_DISCOVERY_URL=https://auth.example.com/.well-known/openid-configuration
OIDC_PROVIDER_NAME=Pocket ID
```

- Register `<BASE_URL>/api/auth/callback/oidc` as the callback URL. If you set `OIDC_PROVIDER_ID`, use that value instead of `oidc`.
- `OIDC_PROVIDER_NAME` labels the button (default `SSO`). `OIDC_SCOPES` overrides the requested scopes (default `openid profile email`).
- `OIDC_DISCOVERY_URL` must use `https://`. Plain `http://` is accepted only for `localhost`.

**Linking existing accounts.** Someone who signed up with a password and later uses your identity provider with the same email keeps their account, but only when both sides are verified. Your provider must send `email_verified: true`, and their OpenReader email must be verified, which needs [account email](#account-email). Providers differ: Pocket ID follows its email-verification setting, Authentik 2025.10 and later sends `false` unless you add a scope mapping, and Keycloak uses each user's flag. If either side is unverified, the person is asked to sign in with their password instead. People without an existing account sign up through the provider, subject to the **New account sign-ups** setting below.

## Sign-ups and guests

Both settings are in **Settings → Admin → Instance → Site features**.

- **New account sign-ups**:
  - **Open** lets anyone register.
  - **Approve** creates pending accounts that can sign in only after an admin approves them in **Users**. Approval does not verify email ownership. If that matters, turn on account email and check that the address is verified before approving.
  - **Closed** refuses new accounts.

  None of these block the [first-admin](./admin-panel#create-the-first-administrator) account.
- **Guest sessions** (off by default) let visitors use the app without an account. A guest who later signs up can keep their documents and progress. Turning it off refuses new guest sessions and signs existing guests out on their next page load.

## Managing users

**Settings → Admin → Users** lists registered and guest accounts with search and filters. Expanding a user shows their activity, sessions, email verification, documents, storage and TTS usage.

Admins can approve pending accounts, suspend or restore them, grant or remove admin access, and delete accounts. Deleting an account first removes its documents and audio; if that cleanup fails, the account is kept so you can try again. Role and access changes sign the affected user out.

You cannot remove the last administrator, and you cannot demote, suspend or delete yourself.

## Account email

Account email is off by default. When it is on, OpenReader sends verification and password-reset emails through [Resend](https://resend.com).

To set it up in **Settings → Admin → Instance → Account email**:

1. Verify your sending domain in Resend.
2. Create a sending-only API key, ideally restricted to that domain.
3. Enter the sender name, sender email, an optional reply-to address and the API key, then save.
4. Send a test and wait for **Accepted by Resend**. This means Resend accepted the request, not that it reached the inbox.
5. Turn on **Enable account emails** and save.

Removing the API key turns account email off.

While it is on:

- New password accounts must follow a verification link (valid for one hour) before they can sign in. Unverified existing accounts are asked to verify on their next sign-in.
- **Forgot password?** sends a reset link, valid for one hour. The page shows the same message whether or not the address exists. A reset signs out every other session.
- People can change their email in **Settings → Account**. The change applies once they follow the link sent to the new address.
- GitHub sign-in and existing sessions are unaffected.

While it is off, verification, email changes and password recovery are unavailable, and queued messages are not sent. People can still change a password they know in **Settings → Account**. Changing a password always signs out other sessions.
