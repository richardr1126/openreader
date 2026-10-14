// The OpenReader desktop shell. It starts the bundled runtime, signs the single
// owner in through the launch-token exchange (v5/DESKTOP_SINGLE_OWNER.md), and
// shows the app in one window. Pages the app does not serve open in the system
// browser.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { exchangeLaunchToken, startRuntime } from './runtime.mjs';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

let runtime = null;
let mainWindow = null;
let quitting = false;

function isAppUrl(url) {
  try {
    return runtime !== null && new URL(url).origin === new URL(runtime.baseUrl).origin;
  } catch {
    return false;
  }
}

function isSignInUrl(url) {
  return isAppUrl(url) && new URL(url).pathname.startsWith('/signin');
}

function openExternally(url) {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Not a URL.
  }
}

/** Converts one Set-Cookie header into the shape `session.cookies.set` takes. */
function parseSetCookie(header, url) {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const cookie = { url, name: pair.slice(0, separator), value: pair.slice(separator + 1) };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.toLowerCase();
    const value = rest.join('=');
    if (key === 'path') cookie.path = value;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = value.toLowerCase() === 'none' ? 'no_restriction' : value.toLowerCase();
    else if (key === 'max-age') cookie.expirationDate = Date.now() / 1000 + Number(value);
    else if (key === 'expires' && cookie.expirationDate === undefined) cookie.expirationDate = Date.parse(value) / 1000;
  }
  return cookie;
}

/** Exchanges the launch token for an owner session in the window's cookie store. */
async function signInOwner() {
  for (const header of await exchangeLaunchToken(runtime)) {
    await session.defaultSession.cookies.set(parseSetCookie(header, runtime.baseUrl));
  }
}

let reauthenticating = null;
/** An expired or revoked session lands on /signin: sign in again and reopen the app. */
function reauthenticate() {
  reauthenticating ??= signInOwner()
    .then(() => mainWindow?.loadURL(`${runtime.baseUrl}/app`))
    .catch((error) => fail('OpenReader could not sign in.', error))
    .finally(() => {
      reauthenticating = null;
    });
}

function guardNavigation(contents) {
  const onNavigate = (event, url) => {
    if (isSignInUrl(url)) {
      event.preventDefault();
      reauthenticate();
    } else if (!isAppUrl(url) && !url.startsWith('file:')) {
      event.preventDefault();
      openExternally(url);
    }
  };
  contents.on('will-navigate', (event) => onNavigate(event, event.url));
  contents.on('will-redirect', (event) => onNavigate(event, event.url));
  // Client-side router navigations change the URL without a page load.
  contents.on('did-navigate-in-page', (_event, url) => {
    if (isSignInUrl(url)) reauthenticate();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) && !isSignInUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    show: false,
    title: 'OpenReader',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(path.join(srcDir, 'loading.html'));
}

function fail(message, error) {
  if (quitting) return;
  const logFile = error?.logFile ?? runtime?.logFile;
  const detail = [error instanceof Error ? error.message : String(error ?? ''), logFile ? `Log: ${logFile}` : '']
    .filter(Boolean)
    .join('\n\n');
  dialog.showErrorBox(message, detail);
  app.quit();
}

async function launch() {
  createWindow();
  try {
    runtime = await startRuntime({
      root: app.isPackaged
        ? path.join(process.resourcesPath, 'runtime')
        : path.resolve(srcDir, '..', 'stage', 'runtime'),
      dataDir: app.getPath('userData'),
      logDir: app.getPath('logs'),
      onExit: ({ code, signal, logFile }) => {
        fail('OpenReader stopped unexpectedly.', Object.assign(new Error(`Exit code ${code ?? signal}.`), { logFile }));
      },
    });
    await signInOwner();
  } catch (error) {
    fail('OpenReader could not start.', error);
    return;
  }
  if (mainWindow) await mainWindow.loadURL(`${runtime.baseUrl}/app`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => guardNavigation(contents));

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (!runtime || quitting) return;
    quitting = true;
    event.preventDefault();
    void runtime.stop().finally(() => app.exit(0));
  });

  void app.whenReady().then(launch);
}
