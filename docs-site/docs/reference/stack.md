---
title: Stack
description: The frameworks, libraries and models OpenReader is built on.
---

OpenReader is a [pnpm](https://pnpm.io/) workspace written in TypeScript. The architecture is described in the repository's `v5/` documents.

| Package | Role |
| --- | --- |
| Root app | Next.js app: sign-in, library, reader, settings, API routes |
| `packages/compute-worker` | Speech generation, alignment, PDF layout, previews, conversion, exports |
| `packages/tts` | Provider clients shared by the app and worker |
| `packages/database` | Drizzle schemas and migrations for SQLite and Postgres |
| `packages/bootstrap` | Startup: configuration checks, migrations, and the embedded services |
| `packages/runtime-config` | Configuration shared by the app and worker |
| `desktop/` | Electron shell for the desktop app (a separate project) |

## App

- **Framework**: [Next.js](https://nextjs.org/) 15 (App Router) and [React](https://react.dev/) 19
- **UI**: [Tailwind CSS](https://tailwindcss.com) 3, [Headless UI](https://headlessui.com), `react-dnd`, `react-dropzone`, `react-hot-toast`
- **Data**: [TanStack Query](https://tanstack.com/query); server-sent events for playback and job progress
- **Readers**: [react-pdf](https://github.com/wojtekmaj/react-pdf) and [pdf.js](https://mozilla.github.io/pdf.js/) for PDF, [epub.js](https://github.com/futurepress/epub.js/) for EPUB, [react-markdown](https://github.com/remarkjs/react-markdown) with [remark-gfm](https://github.com/remarkjs/remark-gfm) for Markdown and text
- **Web import**: [Readability](https://github.com/mozilla/readability), [Turndown](https://github.com/mixmark-io/turndown), [linkedom](https://github.com/WebReflection/linkedom)
- **Text matching**: [cmpstr](https://github.com/remsky/cmpstr)
- **Sign-in**: [Better Auth](https://www.better-auth.com/)
- **Database**: [Drizzle ORM](https://orm.drizzle.team/) with SQLite (`better-sqlite3`) or Postgres (`pg`)
- **Storage**: AWS SDK v3 against embedded [SeaweedFS](https://github.com/seaweedfs/seaweedfs) or any S3-compatible service
- **Logging**: [Pino](https://getpino.io/)

## TTS providers

`packages/tts` uses the [OpenAI SDK](https://github.com/openai/openai-node) for OpenAI, DeepInfra and OpenAI-compatible servers, the [Replicate](https://replicate.com/) client, and [Speech SDK](https://www.npmjs.com/package/@speech-sdk/core) for its hosted services.

## Compute worker

- **Server**: [Fastify](https://fastify.dev/) 5 with an OpenAPI contract; the app's client is generated from it
- **Jobs**: [NATS](https://nats.io/) JetStream work queues and key-value state
- **Inference**: `onnxruntime-node` with `@huggingface/tokenizers`
  - Speech: [Kokoro-82M](https://huggingface.co/richardr1126/Kokoro-82M-OpenReader), exported with its per-phoneme durations so local Kokoro times its own words, with a port of [Misaki](https://github.com/hexgrad/misaki) and [compromise](https://github.com/spencermountain/compromise) for pronunciation
  - Word timing for other providers: timestamped [Whisper base](https://huggingface.co/onnx-community/whisper-base_timestamped) and [Whisper tiny.en](https://huggingface.co/onnx-community/whisper-tiny.en_timestamped)
  - PDF layout: [PP-DocLayoutV3](https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX)
- **Documents**: `pdfjs-dist` and `@napi-rs/canvas` to render pages, `fast-xml-parser` and `jszip` for EPUB, headless [LibreOffice](https://www.libreoffice.org/) for DOCX
- **Audio**: [FFmpeg](https://ffmpeg.org/), a pinned LGPL build in published images and the desktop app (`packaging/ffmpeg`)
- **Exports and email**: `archiver`, [Resend](https://resend.com)

The worker runs embedded in Docker, native and desktop installs, or as its own service. The app talks to it only over HTTP.

## Desktop

[Electron](https://www.electronjs.org/) with `electron-builder` and `electron-updater`. It runs the same server and worker as the Docker image.

## Tooling

- ESLint and TypeScript
- [Vitest](https://vitest.dev/) 4 for unit and integration tests
- [Playwright](https://playwright.dev/) for end-to-end tests in Chromium and WebKit
- [Docusaurus](https://docusaurus.io/) for this site (`docs-site/`)
