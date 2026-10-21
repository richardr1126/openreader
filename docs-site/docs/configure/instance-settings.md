---
title: Instance Settings
description: Defaults and site-wide features in Settings → Admin → Instance.
---

**Settings → Admin → Instance** holds the settings that shape the app for everyone. Changes apply as soon as you save. The key in each table is the name to use when seeding the setting through `RUNTIME_SEED_JSON` (see [Administration](./admin-panel#settings-from-seeds-and-from-the-admin-panel)).

## TTS defaults

| Setting | Key | What it does |
| --- | --- | --- |
| **Default TTS provider** | `defaultTtsProvider` | The provider new users start with. |
| **Show Model & Voice settings** | `enableTtsProvidersTab` | Lets users choose their own provider, model and voice. Turn off to give everyone the default provider. |
| **Show all provider models** | `showAllProviderModels` | Offers every model a provider reports, not only the recommended ones. |

## Site features

| Setting | Key | What it does |
| --- | --- | --- |
| **New account sign-ups** | `signupPolicy` | `open`, `approval` or `closed`. See [Users and Sign-in](./auth#sign-ups-and-guests). |
| **Guest sessions** | `allowAnonymousSessions` | Lets visitors use the app without an account. Off by default. |
| **Audiobook export** | `enableAudiobookExport` | Shows [audiobook export](../guide/audiobook-export) in the reader. |
| **DOCX upload conversion** | `enableDocxConversion` | Accepts `.docx` uploads and converts them to PDF on the compute worker. |
| **Changelog feed URL** | `changelogFeedUrl` | Where the changelog in Settings is loaded from. |

Word highlighting and PDF layout analysis are always on; they run on the compute worker.

## Account email

Sends verification and password-reset emails through Resend. Setup and behavior are described in [Users and Sign-in](./auth#account-email).

## Project Gutenberg

**Add Documents → Project Gutenberg** lets users search the Project Gutenberg catalog and add public-domain books as EPUBs. Books still under US copyright are left out. It is on by default.

The catalog is searched through a [Gutendex](https://github.com/garethbjohnson/gutendex) server. The default public server, `https://gutendex.com`, needs no key but is shared and can be slow: a search it has not answered recently can take a minute or more.

Here you can turn the catalog off, or point it at your own Gutendex server and save its API key. The key is encrypted like provider keys and sent only from the server as `X-API-Key`.

Searches and downloads run on the server. Books are always downloaded from gutenberg.org, whatever the catalog server returns, and count against the maximum upload size.

## Desktop app

In the [desktop app](../desktop-app#updates), this tab also has **Automatic updates**. That choice is saved on the computer, not in the database.
