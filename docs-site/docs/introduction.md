---
id: intro
title: Introduction
slug: /
---

OpenReader is an open-source text-to-speech document reader built with Next.js. It provides a multilingual read-along experience with narration for **EPUB, PDF, TXT, MD, and DOCX documents**.

> Previously named **OpenReader-WebUI**.

It supports multiple TTS providers, including Kokoro running locally in OpenReader itself, OpenAI, Replicate, DeepInfra, and custom OpenAI-compatible endpoints such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), [KittenTTS-FastAPI](https://github.com/richardr1126/KittenTTS-FastAPI), [Orpheus-FastAPI](https://github.com/Lex-au/Orpheus-FastAPI), and [Supertonic](./configure/tts-provider-guides/supertonic).

## 🚀 Get OpenReader

| Option | Best for |
| --- | --- |
| [**Desktop app**](./desktop-app) | One person on macOS, Windows, or Linux. Install and read: no server, Docker, or account. [Download](https://openreader.richardr.dev/download) |
| [**Docker Compose**](./docker-quick-start) | Self-hosting for yourself or several users, on a home server, NAS, or VPS |
| [**Vercel + compute worker**](./deploy/vercel-deployment) | Hosting the web app on Vercel with an external worker |
| [**iPhone, iPad, and Mac**](https://testflight.apple.com/join/eJTYjDwV) | A separate native Swift app with on-device voices, in beta on TestFlight |

## ✨ Highlights

- ▶️ **Progressive Background Generation and Playback**
  - Listening starts as soon as the first segment is ready while the worker generates ahead into one durable document timeline
  - Cached audio is reused across seeks, reloads, and M4B/MP3 exports
- 🧱 **Layout-aware PDF Parsing**
  - PP-DocLayoutV3 (ONNX) detects structured blocks with cross-page stitching and geometry-based highlighting for precise read-along sync and clean TTS segmentation
- ⏱️ **Word-by-word Highlighting** from local Kokoro's own timings, or ONNX Whisper alignment for other providers
  - Powered by the embedded or standalone compute worker control plane (NATS JetStream-backed)
- 📚 **Five Readable Formats**
  - Synchronized EPUB, PDF, TXT, MD, and worker-converted DOCX, with generated PDF/EPUB library previews
- 🎯 **Multi-Provider TTS Support**
  - On-device: **Kokoro (local)** runs Kokoro-82M inside the compute worker, with no separate TTS service or API key
  - Self-hosted: [**Kokoro-FastAPI**](https://github.com/remsky/Kokoro-FastAPI) (multi-voice combinations), [**KittenTTS-FastAPI**](https://github.com/richardr1126/KittenTTS-FastAPI), [**Orpheus-FastAPI**](https://github.com/Lex-au/Orpheus-FastAPI), [**Supertonic**](./configure/tts-provider-guides/supertonic), or any custom OpenAI-compatible endpoint
  - Cloud: [**OpenAI**](https://platform.openai.com/docs/pricing#transcription-and-speech) (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`), [**Replicate**](https://replicate.com/explore) (built-in catalog + any model ID), [**DeepInfra**](https://deepinfra.com/models/text-to-speech) (Kokoro-82M and others)
- 🌐 **Multilingual Support**
  - Choose a document language for language-aware narration and highlighting
  - Available languages depend on the configured provider, model, and voice
- 🎧 **Audiobook Export** in M4B or MP3, assembled by the worker from the same playback cache
- 🗂️ **Flexible Backend** — embedded SeaweedFS or S3-compatible storage, SQLite or Postgres, server library import, and device sync
- 💻 **Desktop App** for macOS, Windows, and Linux, with local voices and automatic updates
- 🔐 **Auth and User Isolation** — auth is required, with optional anonymous auth sessions for guest flows
- 🎨 **Customizable** — 12 built-in light and dark themes plus a custom theme, per-user TTS settings, and document handling controls

## 🧭 Key Docs

- **Use it**: [Library](./guide/library), [Reading and Listening](./guide/reading-and-listening), [Audiobook Export](./guide/audiobook-export), [Keyboard Shortcuts](./guide/keyboard-shortcuts)
- **Install it**: [Desktop App](./desktop-app), [Docker Quick Start](./docker-quick-start), [Docker Compose](./deploy/docker-compose), [Vercel + External Worker](./deploy/vercel-deployment), [Upgrade from v4](./deploy/upgrade-from-v4)
- **Run it**: [Administration](./configure/admin-panel), [TTS Providers](./configure/tts-providers), [Environment Variables](./reference/environment-variables)

## Source Repository

- GitHub: [richardr1126/openreader](https://github.com/richardr1126/openreader)
