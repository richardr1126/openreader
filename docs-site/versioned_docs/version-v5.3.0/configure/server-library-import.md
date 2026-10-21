---
title: Server Library Import
description: Import documents from a folder on the server or computer running OpenReader.
---

**Add Documents → Server Library** lists files in a folder on the server and imports the ones you select. Imported files become ordinary documents in your library. The folder is only a source: removing files from it later does not delete what was imported.

Supported files are PDF, EPUB, HTML, TXT and Markdown (`.md`, `.mdown`, `.markdown`). A listing shows up to 10,000 files.

## Set the folder

By default the folder is `docstore/library`. In Docker, mount your files there, preferably read-only:

```bash
-v /path/to/your/library:/app/docstore/library:ro
```

To use other folders, set `IMPORT_LIBRARY_DIRS` to one or more paths separated by commas, colons or semicolons.

In the [desktop app](../desktop-app), this option is called **Library Folder**. It reads the `docstore/library` folder inside the app's data folder (**Settings → Library and storage → Show data folder**).

:::warning Shared by every user
The folder is set for the whole server, not per user. Everyone who can sign in can browse and import from it. Each import is saved to the importing user's own library.
:::
