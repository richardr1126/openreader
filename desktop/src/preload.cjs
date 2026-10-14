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
  revealDataFolder: () => ipcRenderer.invoke('reveal-data-folder'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
});
