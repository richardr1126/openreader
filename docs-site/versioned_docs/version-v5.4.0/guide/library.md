---
title: Library
description: Add documents to OpenReader and organize them into folders.
---

The library is the first screen you see after signing in. It holds every document you have added. Each document has its own reading position, bookmarks and generated audio.

## Supported formats

| Format | Notes |
| --- | --- |
| PDF | Read with the page layout or as flowing text. Layout analysis finds headers, footers, footnotes, titles and other blocks, and you can choose which of them to skip when reading aloud. |
| EPUB | Read as the book or as flowing text. |
| TXT, Markdown | Read as text. |
| DOCX | Converted to PDF when you upload it. Conversion uses LibreOffice on the compute worker, and an admin can turn it off. |

## Add documents

Choose **Add Documents** at the top of the library sidebar. You can:

- **Upload Files**: pick files, or drop them anywhere on the library.
- **Create Document**: type or paste text and save it as Markdown or plain text.
- **Import from Web**: paste the address of an article. OpenReader pulls out the readable text and saves it as a Markdown document.
- **Project Gutenberg**: search public-domain books and add them as EPUBs. You can filter results by language. An admin can turn this catalog off.
- **Server Library**: import files from a folder on the server that an admin has set up. It is called **Library Folder** in the desktop app. See [Server Library Import](../configure/server-library-import).

The maximum upload size is set by an admin (**Settings → Admin → Compute**).

## Organize

- **Folders** are listed in the library sidebar. Drag documents onto a folder, or use a document's actions menu (**⋯**) to move it.
- **Kinds** in the sidebar filter the library by format.
- **View options** in the toolbar switch between Icons, List and Gallery views. They also sort by name, kind, modified date, size, author or last opened, and filter by reading status (in progress or not started).
- **Search** filters the current view by name.

## Select several documents

Cmd-click (Ctrl-click on Windows and Linux) or Shift-click documents to select them. A bar at the bottom shows how many are selected and lets you move them to a folder or delete them. Cmd/Ctrl+A selects every visible document. Esc clears the selection.

## Previews

PDF and EPUB documents show a thumbnail of their first page or cover. Previews are generated in the background after upload, so a new document can briefly show a placeholder.

## Storage and your data

**Settings → Storage** (**Library and storage** in the desktop app) shows how much space your documents and audio use. From there you can:

- delete all generated audio,
- reclaim audio left behind by deleted documents.

Generated audio is reused until you delete it, so replaying a document never generates it again.

**Settings → Account → Export My Data** downloads your documents and settings as a ZIP. The download link expires after seven days.
