---
id: intro
title: Introduction
slug: /
---

OpenReader is an open source text-to-speech document reader built with Next.js. It provides a read-along experience with narration for **EPUB, PDF, TXT, MD, and DOCX documents**.

> Previously named **OpenReader-WebUI**.

It supports multiple TTS providers including OpenAI, Replicate, DeepInfra, and custom OpenAI-compatible endpoints such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), [KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI), and [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI).

## ✨ Highlights

- 🧱 **Layout-aware PDF Parsing**
  - PP-DocLayoutV3 (ONNX) detects structured blocks with cross-page stitching and geometry-based highlighting for precise read-along sync and clean TTS segmentation
- ⏱️ **Word-by-word Highlighting** via ONNX Whisper alignment
  - Powered by the external compute worker control plane (NATS JetStream-backed)
- ⚡ **Segment-based TTS Playback**
  - Sentence-aware generation with cached audio segments, background preloading, and resumable playback across EPUB, PDF, TXT, MD, and DOCX
- 🎯 **Multi-Provider TTS Support**
  - Self-hosted: [**Kokoro-FastAPI**](https://github.com/remsky/Kokoro-FastAPI) (multi-voice combinations), [**KittenTTS-FastAPI**](https://github.com/richardr1126/KittenTTS-FastAPI), [**Orpheus-FastAPI**](https://github.com/Lex-au/Orpheus-FastAPI), or any custom OpenAI-compatible endpoint
  - Cloud: [**OpenAI**](https://platform.openai.com/docs/pricing#transcription-and-speech) (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`), [**Replicate**](https://replicate.com/explore) (built-in catalog + any model ID), [**DeepInfra**](https://deepinfra.com/models/text-to-speech) (Kokoro-82M and others)
- 🎧 **Audiobook Export** in `m4b`/`mp3` with resumable chapter generation
- 🗂️ **Flexible Backend** — embedded SeaweedFS or S3-compatible storage, SQLite or Postgres, server library import, and device sync
- 🔐 **Auth and User Isolation** — auth is required in v4+, with optional anonymous auth sessions for guest flows
- 🎨 **Customizable** — 13 built-in themes (light and dark palettes), per-user TTS settings, and document handling controls

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
