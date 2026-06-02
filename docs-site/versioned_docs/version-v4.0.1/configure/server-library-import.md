---
title: Server Library Import
---

This page documents how server library import works and how to configure it.

## What it does

Server library import lets you browse files from one or more server directories and import selected files into OpenReader.

- Import is user-driven via a selection modal
- Only selected files are imported
- Imported files become normal OpenReader documents

## FS / Volume Mounts

### App data mount

- Target: `/app/docstore`
- Recommended: yes, for persistence
- Purpose: stores app runtime data, metadata DB, and embedded storage state
- Mount string: `-v openreader_docstore:/app/docstore`

### Library source mount

- Target: `/app/docstore/library`
- Recommended: yes for this feature, use read-only (`:ro`)
- Purpose: exposes host files as import candidates in Server Library Import
- Mount string: `-v /path/to/your/library:/app/docstore/library:ro`

## Import flow

1. Open **Settings -> Documents -> Server Library Import**.
2. Select files in the modal.
3. Click **Import**.

Selected files are fetched from the server library endpoint and imported into OpenReader storage.

:::warning Shared Library Roots
Library roots are configured at the server level (not per-user). Any user who can access Server Library Import can browse/import from the same configured roots.

Imported documents are still saved to the importing user's document scope.
:::

## Supported file types

- `.pdf`
- `.epub`
- `.html`, `.htm`
- `.txt`
- `.md`, `.mdown`, `.markdown`

## Optional: Configure Library Roots

You only need this when the default mounted path is not what you want.

By default, OpenReader uses `docstore/library` as the import root. You can override that with environment variables:

- `IMPORT_LIBRARY_DIRS` (takes precedence): multiple roots separated by comma, colon, or semicolon
- `IMPORT_LIBRARY_DIR`: single root

See [Environment Variables](../reference/environment-variables#library-import) for variable details.

## Notes

- Library listing is capped per request (up to 10,000 files).
- When auth is enabled, library import endpoints require a valid session.
- The mounted library is a source; removing it does not delete already imported documents.
