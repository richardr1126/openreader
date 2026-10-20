// The preload bridge (v5/DESKTOP_SINGLE_OWNER.md): the only native actions the
// page can reach. Each one is fixed; the page never passes a path, so it cannot
// make the shell open or read anything else. The page uses an action only when
// `window.openreaderDesktop` has it. Sandboxed preloads must be CommonJS.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openreaderDesktop', {
  /**
   * Receives documents the owner opened from the menu, the Dock or the file
   * manager, as `{ name, type, bytes }`. Files opened before a page listens are
   * kept and delivered once it does. Returns a function that stops listening.
   */
  onOpenFiles(callback) {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on('open-files', listener);
    ipcRenderer.send('open-files:listen');
    return () => {
      ipcRenderer.removeListener('open-files', listener);
      ipcRenderer.send('open-files:unlisten');
    };
  },
  /** The top bar's colours as hex, for the window controls the shell draws. */
  setTitleBarColors: (colors) => ipcRenderer.send('title-bar-colors', colors),
  revealDataFolder: () => ipcRenderer.invoke('reveal-data-folder'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  /**
   * App updates: `{ state, automatic }`, or null where the app cannot update
   * itself. `state` is `{ status, version, percent }`, status idle, checking,
   * downloading or ready.
   */
  getUpdates: () => ipcRenderer.invoke('updates:get'),
  /** Calls back with each new update state. Returns a function that stops. */
  onUpdateState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },
  /** Resolves to `{ status: latest | available | ready | error, version?, message? }`. */
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  /** Stops the app, installs the downloaded update and reopens. */
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  setAutomaticUpdates: (automatic) => ipcRenderer.invoke('updates:set-automatic', Boolean(automatic)),
});
