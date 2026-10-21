---
title: Administration
description: Create the first administrator and find each admin setting in Settings → Admin.
---

A server install is administered from **Settings → Admin**, which appears for administrators only. Almost everything an admin configures lives there and takes effect without a restart or redeploy. Environment variables cover infrastructure (addresses, secrets, database and storage) and can seed admin settings on first start. See [Environment Variables](../reference/environment-variables).

| Settings → Admin tab | What it manages | Page |
| --- | --- | --- |
| **Users** | Accounts, approvals, admin roles, sign-up policy, guest sessions | [Users and Sign-in](./auth) |
| **Providers** | The text-to-speech services everyone can use | [TTS Providers](./tts-providers) |
| **Instance** | Default provider, site features, account email, Project Gutenberg | [Instance Settings](./instance-settings) |
| **Compute** | Upload size, rate limits, TTS generation tuning | [Compute and Rate Limits](./compute-rate-limiting) |
| **Maintenance** | System check and scheduled cleanup tasks | [Maintenance](./maintenance) |

In the [desktop app](../desktop-app) you are the only user and always an admin. There is no Users tab. The other tabs appear under **General** and **Advanced** in Settings.

## Create the first administrator

A new server install has no accounts. Before the first start, set a one-time first-admin credential in your `.env`:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=<unique-initial-password-at-least-16-characters>
```

Use `BOOTSTRAP_ADMIN_PASSWORD_FILE` instead of the password to read it from a mounted secret file.

1. Start OpenReader. It creates this account once, even if sign-ups are closed.
2. Sign in with it. If [account email](./auth#account-email) is already enabled, follow the verification link it sends first.
3. Change the password in **Settings → Account**. The **Admin** tab appears once you do, and the initial password stops working.

Setup is then complete, with no restart or configuration change. Removing the two values from `.env` afterward is optional tidying.

The email is not an allowlist. It never makes a later sign-up an admin, and the seed never replaces an existing administrator. Deleting the account does not create it again. Grant more admins in **Settings → Admin → Users**. When [upgrading from v4](../deploy/upgrade-from-v4), leave these values unset: existing admins keep their role, and `ADMIN_EMAILS` is no longer used.

## Settings from seeds and from the admin panel

Some admin settings can be given starting values at deploy time:

- `API_BASE`, `API_KEY` and `API_MODEL_NAME` create one shared provider on first start (see [TTS Providers](./tts-providers#seed-a-provider-from-the-environment)).
- `RUNTIME_SEED_JSON` or `RUNTIME_SEED_JSON_PATH` seeds instance settings, compute limits, shared providers, account email and the Project Gutenberg server (see [Environment Variables](../reference/environment-variables#runtime-json-seed)).

Seeds only fill in values that are not set yet. After that, the admin panel is the source of truth, and changing the variables does nothing. Each instance setting shows where its value came from (**From seed**, **From env**, or **Set by admin**). **Reset** returns it to the built-in default.

## How saved keys are protected

Provider API keys, the Resend key and the Gutendex key are encrypted in the database with AES-256-GCM, using a key derived from `AUTH_SECRET`. The admin panel only ever shows the last four characters. Browsers never receive keys or provider addresses. The compute worker fetches provider credentials from the app just in time and never stores them.

:::danger Keep `AUTH_SECRET` stable
Changing `AUTH_SECRET` makes every saved key unreadable, signs everyone out, and invalidates cached audio on installs that derive the playback secret from it. If you must change it, re-enter each provider's API key (and the Resend and Gutendex keys) in the admin panel afterward. There is no automatic re-encryption.
:::
