---
title: Reading and Listening
description: Play a document aloud, follow the highlighting, and change voices and reader settings.
---

Open a document from the library to read it. The player bar at the bottom reads it aloud and highlights each sentence and word as it is spoken.

## Playback

Press **Play** to start from the current position. OpenReader generates audio a little ahead of where you are listening and keeps it, so:

- the first sentence starts after a short preparation, then playback continues without waiting;
- the bar above the controls shows the whole document, with shaded bands where audio is already generated and can be played instantly;
- pausing, seeking, closing the document or reloading never throws away generated audio. Listening again, or [exporting an audiobook](./audiobook-export), reuses it.

Drag the bar to jump anywhere. After a jump, **Undo scrub** returns you to where you were. Skip back and forward move one sentence.

While audio is being prepared, the player says so; it only shows as playing when you can hear it.

## Voice

The **Voice** button in the player opens the voice panel for the current document:

- Pick a voice. Providers that support blending let you select several voices to mix them.
- **Model speed** changes how fast the voice itself speaks. It regenerates audio from your position.
- **Preview selection** plays a short sample before you apply it.
- For external providers, expand **Custom voice ID** to enter a voice missing from the list. Preview it or choose **Use voice**, then **Apply**. Closing the panel discards unapplied changes.

Changes in the voice panel apply **to this book only**. **Use default** returns the book to your default voice. Set the default voice, provider and model for all documents in **Settings → Model & Voice**.

**Playback speed**, the speed button next to the voice button, changes the playback rate instantly and never regenerates audio.

## Reader settings

The settings button in the reader header opens **Reader Settings**:

| Setting | What it does |
| --- | --- |
| **Language** | The language the document is read in. **Automatic** uses the document's metadata or detected language. The available languages depend on the voice and provider. |
| **Show the pages / Show the book** | PDF and EPUB only. Turn off to read the text as flowing sentences. PDFs can show a single page, two pages or continuous scroll. EPUBs can use the app theme. |
| **Highlight sentence / Highlight words** | Turn highlighting of the spoken sentence and word on or off. |
| **Max segment length** | How much text is generated as one piece of audio. |
| **Keyboard shortcuts** | Turns the [playback keys](./keyboard-shortcuts) on or off. |
| **PDF Layout** | PDF only. Shows the detected blocks over the page, re-runs layout analysis, and chooses which block types (headers, footers, footnotes, titles and more) to skip when reading aloud. |

Changing the language, segment length or skipped PDF blocks changes what is spoken. OpenReader asks before applying the change, then regenerates audio from your position.

## Contents and bookmarks

- **Contents** in the reader header lists the chapters or pages. Choose one to go there, or use **Find in book** to search the text and jump to a match.
- **⋯ → Save bookmark** bookmarks the current sentence. **Bookmarks** lists your bookmarks so you can jump back, rename or delete them.

Your reading position, bookmarks and settings are saved to your account and follow you to other devices.
