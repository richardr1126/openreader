---
id: intro
title: Introduction
slug: /
---

OpenReader is an open source text-to-speech document reader built with Next.js. It provides a read-along experience with narration for **EPUB, PDF, TXT, MD, and DOCX documents**.

> Previously named **OpenReader-WebUI**.

It supports multiple TTS providers including OpenAI, DeepInfra, and custom OpenAI-compatible endpoints such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) and [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI).

## ✨ Highlights

- 🎯 **Multi-Provider TTS Support**
  - [**Kokoro-FastAPI**](https://github.com/remsky/Kokoro-FastAPI): supports multi-voice combinations (for example `af_heart+af_bella`)
  - [**Orpheus-FastAPI**](https://github.com/Lex-au/Orpheus-FastAPI)
  - **Custom OpenAI-compatible**: any TTS API with `/v1/audio/voices` and `/v1/audio/speech` endpoints
  - **Cloud TTS providers**:
    - [**DeepInfra**](https://deepinfra.com/models/text-to-speech): Kokoro-82M and other hosted models
    - [**OpenAI API**](https://platform.openai.com/docs/pricing#transcription-and-speech): `tts-1`, `tts-1-hd`, and `gpt-4o-mini-tts`
- 🛜 **Server-side Document Storage**
  - Documents are persisted in server blob/object storage for consistent access
- 📚 **External Library Import**
  - Import documents from server-mounted folders
- 🎧 **Server-side Audiobook Export** in `m4b`/`mp3` with resumable chapter generation
- 📖 **Read Along Experience**
  - Real-time highlighting for PDF/EPUB, with optional word-level [whisper.cpp](https://github.com/ggml-org/whisper.cpp) timestamps
- 🔐 **Auth Optional by Design**
  - Run no-auth for local use, or enable auth with user isolation and claim flow
- 🗂️ **Flexible Storage and Database Modes** with embedded defaults or external S3/Postgres
- 🚀 **Production-ready Server Behavior** with TTS caching/retries/rate limits and startup migrations
- 🎨 **Customizable Experience**
  - Theme, TTS, and document handling controls

## 🧭 Key Docs

- [Docker Quick Start](./docker-quick-start)
- [Local Development](./deploy/local-development)
- [Vercel Deployment](./deploy/vercel-deployment)
- [Environment Variables](./reference/environment-variables)
- [Auth](./configure/auth)
- [Database](./configure/database)
- [Object / Blob Storage](./configure/object-blob-storage)
- [Migrations](./configure/migrations)
- [Server Library Import](./configure/server-library-import)
- [TTS Providers](./configure/tts-providers)

## Source Repository

- GitHub: [richardr1126/openreader](https://github.com/richardr1126/openreader)
