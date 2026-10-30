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

### Browsing while it reads

Scrolling or turning pages yourself stops the reader from following the narration, so you can look around without interrupting playback. The **Follow narration** button beside the page controls shows whether the reader is following. While it is off, **↩ Return to narration** jumps back to the sentence being read and follows again. Tapping a sentence, jumping from the contents, or scrubbing the player also follows again.

## Voice

The **Voice** button in the player opens the voice panel for the current document:

- Pick a voice. A long list shows its first few voices; **Show more** reveals the rest as you scroll, and **Search voices** finds one by name or language. Star a voice to add it to **Favorites**, then use the Favorites filter to see only those. Favorites are saved to your account for each model.
- Providers that support blending let you select several voices to mix them.
- **Model speed** changes how fast the voice itself speaks. It regenerates audio from your position.
- **Preview selection** plays a short sample before you apply it.
- For external providers, expand **Custom voice ID** to enter a voice missing from the list. Preview it or choose **Use voice**, then **Apply**. Closing the panel discards unapplied changes.

- **Skip when reading aloud** chooses text the voice leaves out. See [Skipping text](#skipping-text).

Changes in the voice panel apply **to this book only**. **Use default** returns the book to your default voice. Set the default voice, provider and model for all documents in **Settings → Model & Voice**.

**Playback speed**, the speed button next to the voice button, changes the playback rate instantly and never regenerates audio.

### Skipping text

| Setting | What it does |
| --- | --- |
| **Citations** | Skip reference markers such as `[1, 3–5]` and `(Smith, 2024)`. Bare numbers and years are still read. |
| **Bracketed text** | Skip text in **Square brackets**, **Parentheses** or **Both**. |
| **PDF block kinds** | PDF only. Choose which detected blocks (headers, footers, footnotes, titles and more) to skip. |

Skipped text stays visible and highlighted words still line up with the audio. Citations and bracketed text are read by default, while PDFs skip headers, footers and footnotes; set the defaults in **Settings → Model & Voice**, and a reset icon beside a changed setting returns the book to them. A change asks first, then regenerates audio from your position.

### Your own voice

With a [Fish Audio](../configure/tts-provider-guides/fish-audio) provider, or an [OpenRouter](../configure/tts-provider-guides/openrouter) model that supports voice cloning, **Your voices** in the voice list offers **Create your own voice**:

1. **Record** the passage shown on screen, or **Import** an audio file. One person speaking evenly for 10 to 15 seconds works best.
2. Review the sample and trim it to between 1 and 15.9 seconds.
3. Name the voice. The **Sample transcript** is filled with the passage you read; correct it if you said something else. Fish Audio requires it; for OpenRouter it is optional.
4. Confirm you have permission to use the voice, then save it.

The new voice appears under **Your voices**, where its menu can rename or delete it. Choose it like any other voice, then **Save** in settings or **Apply** in the reader. Deleting a voice removes its sample but keeps narration already generated with it.

The sample is stored privately on your OpenReader server and is sent to the provider with each narration request. The provider's usage charges apply.

## Reader settings

The settings button in the reader header opens **Reader Settings** for the current document. Most settings here start from your app defaults and change only this book. A reset icon beside a changed setting returns it to the app default.

| Setting | What it does |
| --- | --- |
| **Language** | The language the document is read in. **Automatic** uses the document's metadata or detected language. The available languages depend on the voice and provider. |
| **Display** | PDF and EPUB only. **Show the pages / Show the book** turns the page layout on or off; off reads the text as flowing sentences. PDFs can show a single page, two pages or continuous scroll. EPUBs can use the app theme. |
| **Typography** | Flowing text and EPUB. See [Typography](#typography). |
| **Highlight appearance** | **Highlight segment** and **Highlight words** turn highlighting of the spoken passage and word on or off, and set their colors. See [Highlights](#highlights). |
| **Advanced** | What is read aloud and how. See [Advanced](#advanced). |
| **PDF Layout** | PDF only. Shows the processing status, re-runs layout analysis, and **Show block overlay** draws the detected blocks over the page. |

Changing the language or anything under **Advanced** changes what is spoken. OpenReader asks before applying the change, then regenerates audio from your position. Display, typography and highlight changes never regenerate audio.

### Typography

**Font family** and **Text size** come first; **More typography** adds:

- **Spacing**: line spacing, paragraph spacing and letter spacing, with **Compact**, **Balanced** and **Open** presets.
- **Width**: how wide the text column is, with **Compact**, **Balanced** and **Full** presets.
- **Alignment**: **Default**, **Left** or **Justified**.

The reading preview shows the result before you save. With **Default / publisher**, EPUBs keep the book's own fonts and spacing, and other text uses the app's font. Typography doesn't apply to PDFs shown as pages.

### Highlights

Choose a preset (**Theme**, **Amber**, **Ocean** or **Mint**), or set the segment and word colors and opacity separately. You can turn off the segment highlight and keep the word highlight, or the other way round.

### Advanced

| Setting | What it does |
| --- | --- |
| **Text grouping** | Built-in Kokoro only. **Piece length** sets how much text the model speaks in one pass. |
| **Added pauses** | Extra silence **Between segments**, and for built-in Kokoro **Between pieces**. **Automatic** adds none, keeping the voice's natural pauses. Added pauses are included in audiobook exports. |
| **Max segment length** | How much text is generated as one piece of audio. |

## App settings

**Settings** holds the defaults every book starts from:

- **Model & Voice**: your default provider, model and voice, and the defaults for [skipping text](#skipping-text) and the **Advanced** settings above.
- **Customize**: the app theme, whether PDFs and EPUBs open showing their pages, the default typography and highlights, and [keyboard shortcuts](./keyboard-shortcuts).

A book you have changed keeps its own setting; everything else follows the defaults.

## Contents and bookmarks

- **Contents** in the reader header lists the chapters or pages. Choose one to go there, or use **Find in book** to search the text and jump to a match.
- **⋯ → Save bookmark** bookmarks the current sentence. **Bookmarks** lists your bookmarks so you can jump back, rename or delete them.

Your reading position, bookmarks and settings are saved to your account and follow you to other devices.
