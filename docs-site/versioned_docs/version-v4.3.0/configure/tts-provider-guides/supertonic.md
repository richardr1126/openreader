---
title: Supertonic
---

Run [Supertonic](https://github.com/supertone-inc/supertonic-py) locally and connect it to OpenReader using the `Custom OpenAI-Like` provider. Supertonic is a fast, on-device TTS engine that ships its own OpenAI-compatible HTTP server.

:::note No Docker image
Supertonic does not publish a Docker image — it installs as a Python package and runs as a local HTTP server. These instructions assume OpenReader itself runs in Docker (the common case); see [Running OpenReader directly on the host](#running-openreader-directly-on-the-host) if you don't.
:::

## Run Supertonic

Install with `pip` (or `pipx` for an isolated install) and start the server:

```bash
pipx install 'supertonic[serve]'   # or: pip install 'supertonic[serve]'
supertonic serve                   # defaults; loopback only
```

The first run downloads the model (~400MB). Once it's up, the OpenAI-compatible endpoint is at `http://127.0.0.1:7788/v1/audio/speech` and interactive docs are at `http://127.0.0.1:7788/docs`.

- **Models:** `supertonic-3` (default) or `supertonic-2`.
- **Voices:** built-ins `M1`–`M5` and `F1`–`F5`, plus any custom voices you import. OpenReader discovers them automatically via the `/v1/styles` endpoint.
- **Audio format:** Supertonic emits `wav` by default; OpenReader transcodes it to mp3 transparently, so no extra configuration is needed.

## Connect to OpenReader

From a Docker container, your host machine is reachable at `host.docker.internal`, so the base URL is `http://host.docker.internal:7788/v1`. On Docker Desktop (macOS/Windows) this reaches the loopback-bound server above with no extra setup.

:::note Linux (native Docker Engine)
On native Linux Docker, `host.docker.internal` needs `--add-host=host.docker.internal:host-gateway` on the OpenReader container (or the equivalent `extra_hosts` entry in `docker-compose.yml`), and it routes to the host's bridge interface rather than loopback. Pick one:

- Run the OpenReader container with `--network host` (or `network_mode: host`), keep Supertonic on `--host 127.0.0.1`, and use `http://127.0.0.1:7788/v1` as the base URL.
- Or start Supertonic with `--host 0.0.0.0` so the bridge can reach it — keep it on a trusted network or behind a firewall.
:::

**Recommended (auth + admin): Settings → Admin → Shared providers**

1. Add a shared provider with type `custom-openai`.
2. Set base URL to `http://host.docker.internal:7788/v1`.
3. Leave API key blank — `supertonic serve` does not require one.
4. Set default model to `supertonic-3` (or `supertonic-2`).

**Legacy bootstrap seed (optional, first boot only):**

```env
API_BASE=http://host.docker.internal:7788/v1
```

**Or in-app via Settings → TTS Provider:**

1. Set provider to `Custom OpenAI-Like`.
2. Set `API_BASE` to `http://host.docker.internal:7788/v1`.
3. Leave `API_KEY` blank.
4. Choose model `supertonic-3` (or the model your deployment exposes).

See [TTS Providers](../tts-providers) for admin-shared vs per-user behavior.

## Running OpenReader directly on the host

If OpenReader runs on the same machine (e.g. `pnpm dev`) rather than in Docker, skip `host.docker.internal` and use `http://127.0.0.1:7788/v1` as the base URL everywhere above.

## References

- [supertone-inc/supertonic-py](https://github.com/supertone-inc/supertonic-py)
- [Supported Languages](https://github.com/supertone-inc/supertonic-py#supported-languages)
- [TTS Providers](../tts-providers)
- [TTS Environment Variables](../../reference/environment-variables#tts-provider-and-request-behavior)
