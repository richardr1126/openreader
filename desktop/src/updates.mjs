// Updates from GitHub Releases through electron-updater. With automatic updates
// on (the default, kept in <userData>/updates.json), the packaged app checks
// shortly after launch and every few hours and downloads a newer release in the
// background. The page shows the state through the bridge: Settings checks on
// demand, and the library offers Restart to update once a download is ready. An
// update not installed then installs when the app quits. Installing first stops
// the runtime, so no bundled process holds files the installer replaces. Checks
// and failures are logged to <logs>/updates.log.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 1024 * 1024;

function fileLogger(file) {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  const write = (level) => (message) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
    } catch {
      // Logging must never break updating.
    }
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug() {} };
}

/** The first line of an updater error, without the response dump that follows. */
function shortMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].replace(/^(Error: )+/, '').slice(0, 200);
}

/**
 * `state` is `{ status, version, percent }` with status idle, checking,
 * downloading or ready; `onChange` fires whenever it changes. `beforeInstall`
 * hides the window and stops the runtime.
 */
export function createUpdates({ beforeInstall, onChange }) {
  // Unpackaged runs have no app-update.yml to read.
  const supported = app.isPackaged;
  const preferencesFile = () => path.join(app.getPath('userData'), 'updates.json');
  let state = { status: 'idle', version: null, percent: null };
  let checking = null;
  let timers = [];
  let listening = false;
  let installing = false;

  const setState = (next) => {
    state = { ...state, ...next };
    onChange(state);
  };

  function readAutomatic() {
    try {
      return JSON.parse(fs.readFileSync(preferencesFile(), 'utf8')).automatic !== false;
    } catch {
      return true;
    }
  }

  function listen() {
    if (listening) return;
    listening = true;
    autoUpdater.logger = fileLogger(path.join(app.getPath('logs'), 'updates.log'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', ({ percent }) => {
      const rounded = Math.floor(percent);
      if (rounded !== state.percent) setState({ percent: rounded });
    });
    autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info.version, percent: null }));
    // A failed download returns to idle, so the next check tries again.
    autoUpdater.on('error', () => {
      if (state.status === 'downloading') setState({ status: 'idle', version: null, percent: null });
    });
  }

  /**
   * One check at a time. Resolves to latest, available (now downloading), ready
   * or error. A newer release whose feed for this platform is not uploaded yet
   * counts as latest.
   */
  function check() {
    if (state.status === 'ready') return Promise.resolve({ status: 'ready', version: state.version });
    if (state.status === 'downloading') return Promise.resolve({ status: 'available', version: state.version });
    listen();
    checking ??= (async () => {
      setState({ status: 'checking' });
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) {
          setState({ status: 'idle' });
          return { status: 'latest' };
        }
        // update-available has already moved the state to downloading.
        return { status: 'available', version: result.updateInfo.version };
      } catch (error) {
        if (state.status === 'checking') setState({ status: 'idle' });
        if (error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return { status: 'latest' };
        return { status: 'error', message: shortMessage(error) };
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  function schedule(automatic) {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    if (!supported || !automatic) return;
    timers.push(setTimeout(() => void check(), FIRST_CHECK_DELAY_MS));
    timers.push(setInterval(() => void check(), CHECK_INTERVAL_MS));
  }

  return {
    supported,
    get state() {
      return state;
    },
    /** Starts background checks when they are on; call once the runtime is up. */
    start() {
      schedule(readAutomatic());
    },
    check() {
      return supported ? check() : Promise.resolve({ status: 'error', message: 'This build cannot update itself.' });
    },
    get automatic() {
      return readAutomatic();
    },
    setAutomatic(automatic) {
      fs.writeFileSync(preferencesFile(), `${JSON.stringify({ automatic })}\n`);
      schedule(automatic);
    },
    async install() {
      if (installing || state.status !== 'ready') return;
      installing = true;
      await beforeInstall().catch(() => {});
      // Silent on Windows (no installer wizard) and relaunched afterwards.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
