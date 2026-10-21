---
title: Desktop App
description: Install OpenReader Desktop for macOS, Windows, or Linux. No server, Docker, or account required.
---

OpenReader Desktop is the full OpenReader reader packaged as one app for macOS, Windows, and Linux. You get the same read-along playback, word highlighting, PDF layout analysis, and audiobook export as a server install. There is no Docker, server, or account to set up.

**[Download OpenReader Desktop](https://openreader.richardr.dev/download)**. The download page picks the right installer for your computer and lists past versions.

## Platforms

| Platform | Installers | Requirement |
| --- | --- | --- |
| macOS | `.dmg` for Apple silicon (signed and notarized) | macOS 12 or later |
| Windows | `.exe` for x64 and Arm | Windows 10 or later |
| Linux | `AppImage` and `.deb` for x86-64 and ARM64 | Most distributions; `.deb` for Debian and Ubuntu |

Windows and Linux installers are not code-signed, so Windows SmartScreen may ask you to confirm the first launch. Intel Macs have no build; use [Docker Compose](./deploy/docker-compose) instead.

Every installer is also attached to its [GitHub release](https://github.com/richardr1126/openreader/releases).

## What is inside

The app runs the same runtime as the slim Docker image: the Next.js app, the embedded compute worker, NATS, SeaweedFS, SQLite, and FFmpeg. Everything listens only on `127.0.0.1`, on ports chosen when the app starts, so it can run beside a development stack or a Docker install.

You are signed in automatically as the app's only owner. There are no passwords, user management, or sign-up settings.

## Voices

A fresh install is set up with **Kokoro (local)**, which runs Kokoro-82M on your computer with no API key. On first launch, the app asks you to either download its voices (about 336 MB) or set up a voice service. You can keep reading while the voices download. To remove the voices later, or download them again, use the Kokoro card in **Settings → Providers**.

Kokoro (local) is English only. For other languages or voices, add a cloud provider or a self-hosted server in the same place; see [TTS Providers](./configure/tts-providers).

## Opening documents

- **File → Open…** (Cmd+O or Ctrl+O) opens PDF, EPUB, TXT, Markdown, and DOCX files.
- Drag files from your file manager onto the library.
- The app registers itself for `.epub` and offers itself for `.pdf`, so you can use **Open With**. On Linux, the `.deb` registers these file types; an AppImage does not unless you integrate it.

DOCX conversion needs [LibreOffice](https://www.libreoffice.org/), which is not bundled. Install it in its standard location and the app finds it.

## Updates

The app checks GitHub Releases for new versions and downloads them in the background. **Restart to update** appears in the library sidebar once one is ready; otherwise it installs the next time you quit. You can also choose **Check for updates** in Settings or the application menu.

To turn off automatic updates, go to **Settings → Instance → Desktop app**. An update check sends nothing about your library.

On Linux, a `.deb` update asks for your password. An AppImage moved to a read-only location cannot update itself.

## Your data

Your library, settings, generated audio, and voice models are stored in the app's data folder (`OpenReader` in your system's application data folder). **Settings → Library and storage → Show data folder** opens it. **Settings → Maintenance → Open logs folder** opens the logs, which are useful when reporting a problem.

Uninstalling the app leaves this folder in place, so reinstalling keeps your library.

What the app sends over the network, and when, is in the [desktop privacy policy](https://openreader.richardr.dev/desktop-privacy).

## Native iPhone, iPad, and Mac app

OpenReader for iPhone, iPad, and Mac is a separate Swift app with on-device voices. It is in beta on [TestFlight](https://testflight.apple.com/join/eJTYjDwV). It is a different product from OpenReader Desktop and does not share its library.
