// The OpenReader desktop shell. It starts the bundled runtime, signs the single
// owner in through the launch-token exchange (v5/DESKTOP_SINGLE_OWNER.md), and
// shows the app in one window. Pages the app does not serve open in the system
// browser. The preload bridge (preload.cjs) is the page's only way into the
// shell, and every bridge call must come from the app's own origin.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import { buildMenu } from './menu.mjs';
import { DOCUMENT_EXTENSIONS, DocumentInbox, documentPathsInArgv } from './open-documents.mjs';
import { exchangeLaunchToken, startRuntime } from './runtime.mjs';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

// Keep existing libraries, secrets and browser sessions when the product name
// changes. Electron otherwise derives userData from the new product name.
const dataDir = path.join(app.getPath('appData'), 'OpenReader');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);

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

/** Loads an app page in the window once the runtime is up. */
function showAppPage(pathname) {
  if (!runtime || !mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  void mainWindow.loadURL(`${runtime.baseUrl}${pathname}`);
}

const inbox = new DocumentInbox({
  openLibrary: () => {
    // The library page is loading or hydrating when it is already the URL; its
    // listener collects the documents once it registers.
    if (mainWindow && isAppUrl(mainWindow.webContents.getURL())
      && new URL(mainWindow.webContents.getURL()).pathname === '/app') return;
    showAppPage('/app');
  },
});

async function chooseDocuments() {
  if (!mainWindow) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: DOCUMENT_EXTENSIONS }],
  });
  if (!canceled) openDocuments(filePaths);
}

function openDocuments(paths) {
  inbox.open(paths).catch((error) => {
    dialog.showErrorBox('OpenReader Desktop could not open the document.', error instanceof Error ? error.message : String(error));
  });
}

/** Bridge calls are honoured only from the app's own pages. */
function fromApp(event) {
  return isAppUrl(event.senderFrame?.url ?? '');
}

function registerBridge() {
  ipcMain.on('open-files:listen', (event) => {
    if (fromApp(event)) inbox.listen(event.sender);
  });
  ipcMain.on('open-files:unlisten', (event) => inbox.unlisten(event.sender));
  ipcMain.on('title-bar-colors', (event, colors) => {
    if (!fromApp(event) || process.platform === 'darwin') return;
    const window = BrowserWindow.fromWebContents(event.sender);
    const { background, foreground } = colors ?? {};
    if (!window || !HEX_COLOR.test(background) || !HEX_COLOR.test(foreground)) return;
    window.setTitleBarOverlay(titleBarOverlay(background, foreground));
  });
  ipcMain.handle('reveal-data-folder', async (event) => {
    if (fromApp(event)) await shell.openPath(app.getPath('userData'));
  });
  ipcMain.handle('open-logs-folder', async (event) => {
    if (fromApp(event)) await shell.openPath(app.getPath('logs'));
  });
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
    .catch((error) => fail('OpenReader Desktop could not sign in.', error))
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

// The app's top bar is the window's title bar on every platform: the native
// controls (traffic lights, or minimise/maximise/close) sit inside it through
// the Window Controls Overlay, and the page reserves their space with the
// titlebar-area CSS environment variables (src/app/globals.css). The height
// matches the app's 40px top bars.
const TITLE_BAR_HEIGHT = 40;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Windows and Linux draw the controls themselves, in the page's colours. */
function titleBarOverlay(color, symbolColor) {
  if (process.platform === 'darwin') return true;
  return { color, symbolColor, height: TITLE_BAR_HEIGHT };
}

function createWindow() {
  // Until the page reports its theme, match loading.html.
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    show: false,
    title: app.getName(),
    backgroundColor: dark ? '#141413' : '#f8f8f6',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(dark ? '#141413' : '#f8f8f6', dark ? '#ececea' : '#1c1c1a'),
    // Centres the traffic lights in the top bar.
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(srcDir, 'preload.cjs'),
    },
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
        fail('OpenReader Desktop stopped unexpectedly.', Object.assign(new Error(`Exit code ${code ?? signal}.`), { logFile }));
      },
    });
    await signInOwner();
  } catch (error) {
    fail('OpenReader Desktop could not start.', error);
    return;
  }
  if (mainWindow) await mainWindow.loadURL(`${runtime.baseUrl}/app`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS delivers opened files as events, possibly before the app is ready;
  // Windows and Linux pass them on the command line.
  app.on('open-file', (event, file) => {
    event.preventDefault();
    openDocuments([file]);
  });
  openDocuments(documentPathsInArgv(process.argv.slice(1)));

  app.on('second-instance', (_event, argv) => {
    openDocuments(documentPathsInArgv(argv.slice(1)));
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

  void app.whenReady().then(() => {
    registerBridge();
    Menu.setApplicationMenu(buildMenu({
      isMac: process.platform === 'darwin',
      isPackaged: app.isPackaged,
      onOpen: () => void chooseDocuments(),
      onSettings: () => showAppPage('/app/settings'),
      onOpenLogs: () => void shell.openPath(app.getPath('logs')),
      openExternal: openExternally,
    }));
    return launch();
  });
}
