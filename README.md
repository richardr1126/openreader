[![GitHub Release](https://img.shields.io/github/v/release/richardr1126/openreader)](https://github.com/richardr1126/openreader/releases)
[![License](https://img.shields.io/github/license/richardr1126/openreader)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-openreader-0a6c74)](https://docs.openreader.richardr.dev/)
[![Playwright Tests](https://github.com/richardr1126/openreader/actions/workflows/playwright.yml/badge.svg)](https://github.com/richardr1126/openreader/actions/workflows/playwright.yml)
[![Docs Check](https://github.com/richardr1126/openreader/actions/workflows/docs-check.yml/badge.svg)](https://github.com/richardr1126/openreader/actions/workflows/docs-check.yml)

[![GitHub Stars](https://img.shields.io/github/stars/richardr1126/openreader)](https://github.com/richardr1126/openreader/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/richardr1126/openreader)](https://github.com/richardr1126/openreader/network/members)
[![Discussions](https://img.shields.io/badge/Discussions-Ask%20a%20Question-blue)](https://github.com/richardr1126/openreader/discussions)

# 📄🔊 OpenReader

OpenReader is an open-source, self-host-friendly text-to-speech document reader built with Next.js for **EPUB, PDF, TXT, MD, and DOCX** with multilingual, synchronized read-along playback.

> Previously named **OpenReader-WebUI**.

## 💻 Download the Desktop App

**[OpenReader Desktop](https://openreader.richardr.dev/download)** is the full reader in one app for macOS, Windows, and Linux, with local voices, audiobook export, and automatic updates. No server, Docker, or account to set up.

| Platform | Installers |
| --- | --- |
| macOS 12+ | `.dmg` for Apple silicon (signed and notarized) |
| Windows 10+ | `.exe` for x64 and Arm |
| Linux | `AppImage` and `.deb` for x86-64 and ARM64 |

**[Download for your computer](https://openreader.richardr.dev/download)** · [Desktop docs](https://docs.openreader.richardr.dev/desktop-app) · [All releases](https://github.com/richardr1126/openreader/releases)

Want to self-host for several people instead? **Get started in the [docs](https://docs.openreader.richardr.dev/)**. On iPhone, iPad, or Mac, try the separate native app on [TestFlight](https://testflight.apple.com/join/eJTYjDwV).

## ✨ Highlights

- ▶️ **Progressive background generation and playback** — begin listening as soon as the first
  segment is ready while the worker continues generating ahead into one durable document timeline;
  cached audio is reused across seeks, reloads, and exports.
- 🧱 **Layout-aware PDF parsing** with PP-DocLayoutV3 (ONNX) — structured block detection, cross-page stitching, and geometry-based highlighting for precise read-along sync.
- ⏱️ **Word-by-word highlighting** from local Kokoro's own phoneme durations, or ONNX Whisper alignment for other providers, through the compute worker control plane (NATS JetStream-backed).
- 📚 **Five readable formats** — synchronized EPUB, PDF, TXT, MD, and worker-converted DOCX,
  with generated PDF/EPUB library previews.
- 🎯 **Multi-provider TTS** — Kokoro running locally with no API key, self-hosted OpenAI-compatible servers (Kokoro-FastAPI, KittenTTS-FastAPI, Orpheus-FastAPI, Supertonic), or cloud APIs (OpenAI, Replicate, DeepInfra, and ElevenLabs, Cartesia, Google, and more through Speech SDK).
- 🌐 **Multilingual support** — choose a document language for language-aware narration and highlighting. Available languages depend on the configured TTS provider and voice.
- 🎧 **Audiobook export** in M4B or MP3, assembled by the worker from the same playback cache.
- 🗂️ **Flexible backend** — embedded SeaweedFS or S3-compatible storage, SQLite or Postgres, server library import, and device sync.
- 💻 **Desktop app** for macOS, Windows, and Linux, with local voices and automatic updates.
- 🐳 **Self-host friendly** — Docker (amd64/arm64), built-in auth/session support, and automatic startup migrations.

## 🚀 Start Here

| Goal | Link |
| --- | --- |
| Install the desktop app | [Download](https://openreader.richardr.dev/download) · [Desktop App docs](https://docs.openreader.richardr.dev/desktop-app) |
| Run with Docker Compose | [Docker Compose](https://docs.openreader.richardr.dev/deploy/docker-compose) |
| Deploy on Vercel | [Vercel Deployment](https://docs.openreader.richardr.dev/deploy/vercel-deployment) |
| Deploy external compute worker | [Compute Worker (NATS JetStream)](https://docs.openreader.richardr.dev/deploy/compute-worker) |
| Develop locally | [Local Development](https://docs.openreader.richardr.dev/deploy/local-development) |
| Configure auth | [Auth](https://docs.openreader.richardr.dev/configure/auth) |
| Configure SQL database | [Database and Migrations](https://docs.openreader.richardr.dev/configure/database) |
| Configure object storage | [Object / Blob Storage](https://docs.openreader.richardr.dev/configure/object-blob-storage) |
| Configure TTS providers | [TTS Providers](https://docs.openreader.richardr.dev/configure/tts-providers) |
| Run Kokoro locally | [Kokoro-FastAPI](https://docs.openreader.richardr.dev/configure/tts-provider-guides/kokoro-fastapi) |
| Run KittenTTS locally | [KittenTTS-FastAPI](https://docs.openreader.richardr.dev/configure/tts-provider-guides/kitten-tts-fastapi) |
| Upgrade a v4 instance | [Upgrade from v4](https://docs.openreader.richardr.dev/deploy/upgrade-from-v4) |
| Get support or contribute | [Support and Contributing](https://docs.openreader.richardr.dev/about/support-and-contributing) |

## 🧭 Community

- Questions and ideas: [GitHub Discussions](https://github.com/richardr1126/openreader/discussions)
- Bug reports: [GitHub Issues](https://github.com/richardr1126/openreader/issues)
- Contributions: open a pull request

## 📜 License

MIT. See [LICENSE](LICENSE).
