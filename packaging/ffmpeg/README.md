# ffmpeg

OpenReader's compute worker spawns ffmpeg to normalize provider audio, probe
durations, decode audio for Whisper alignment, and export audiobooks. Everything
OpenReader distributes (Docker images and desktop packages) ships an **LGPL**
ffmpeg that OpenReader builds itself from the official sources: only the audio
components OpenReader uses, statically linked with LAME, about 5 MB per binary.
No GPL or nonfree ffmpeg is ever shipped.

| Target | Built on | Notes |
|---|---|---|
| `darwin-universal` | macOS | arm64 + x86_64 in one binary, macOS 12+ |
| `linux-x64`, `linux-arm64` | Alpine Linux | fully static (musl), runs on any distribution |
| `win32-x64`, `win32-arm64` | Linux, cross-compiled with llvm-mingw | needs only DLLs that ship with Windows 10+ |

## Files

- `manifest.json`: the FFmpeg version, the GitHub release that holds the builds,
  and the SHA-256 of each target's archive. The single source of truth.
- `build.sh`: builds one target from signature- and hash-verified FFmpeg and LAME
  sources (and a hash-pinned llvm-mingw for Windows), or collects those sources
  with `sources`. Run through the `ffmpeg` workflow.
- `fetch.mjs`: downloads one target, verifies its SHA-256, and writes
  `ffmpeg`/`ffmpeg.exe`, `LICENSE.txt` and `SOURCE.txt` into `--out`. When the
  target runs on the current machine it also runs the smoke test.
- `smoke-test.mjs`: rejects GPL or nonfree builds and runs every ffmpeg
  operation OpenReader performs. Keep it in step with the callers it lists.

## Consumers

The worker reads one variable, `FFMPEG_BIN` (`packages/tts/src/ffmpeg-bin.ts`).

- **Docker images** fetch the Linux target in an `ffmpeg-fetch` stage, copy it to
  `/opt/ffmpeg`, and set `FFMPEG_BIN=/opt/ffmpeg/ffmpeg`.
- **Desktop packages** run `fetch.mjs --target <target> --out <dir>` for each
  platform they build, ship that directory as an unpacked resource, and set
  `FFMPEG_BIN` to it. On macOS, the app's code signing re-signs the binary with
  the hardened runtime.
- **Development** uses the `ffmpeg-static` dev dependency: the bootstrap and the
  Vitest config set `FFMPEG_BIN` to it when unset. It is never shipped.

Shipping `LICENSE.txt` and `SOURCE.txt` next to the binary, plus the
acknowledgements entry, meets the LGPL notice and source obligations: the release
carries the exact FFmpeg and LAME sources and the build script. ffmpeg runs as a
separate process, so OpenReader itself stays MIT.

## Publishing a build

1. Set `ffmpegVersion` and a new `release` (`ffmpeg-lgpl-<version>-<revision>`)
   in `manifest.json`, and set every `sha256` to `null`. Bump the revision when
   rebuilding the same FFmpeg version, for example after changing configure
   options or the LAME or llvm-mingw pins in `build.sh`.
2. Commit, then push a tag with the release name. The **Build LGPL ffmpeg**
   workflow builds every target, smoke-tests each one on its own platform
   (including Intel macOS, glibc Linux, and Windows x64 and Arm), and publishes
   the release.
3. Copy the `sha256` block the workflow prints into `manifest.json`.

Until step 3, Docker image builds fail at the `ffmpeg-fetch` stage with a message
saying the target is not pinned.

**Adding an ffmpeg operation.** Add it to `smoke-test.mjs`. If the build lacks a
component the operation needs, the smoke test fails; enable that component in
`build.sh` and publish a new revision.

**Building locally.** `build.sh` needs the platform it names. For example, the
`linux-arm64` target on an Apple Silicon Mac with Docker:

```bash
docker run --rm -v "$PWD:/repo:ro" -v /tmp/ffmpeg:/work alpine:3.22 sh -c 'apk add -q bash build-base curl gnupg nodejs tar xz && bash /repo/packaging/ffmpeg/build.sh linux-arm64 /work'
```
