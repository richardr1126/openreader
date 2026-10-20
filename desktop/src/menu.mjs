// The application menu. Standard roles supply editing, zoom, full screen and the
// window list; the shell adds Open…, Settings, Check for Updates… and Help.
// Playback keeps its existing controls: media keys through mediaSession and the
// page's own keys.

import { Menu } from 'electron';

const DOCS_URL = 'https://docs.openreader.richardr.dev';

const UPDATE_LABELS = {
  idle: 'Check for Updates…',
  checking: 'Checking for Updates…',
  downloading: 'Downloading Update…',
  ready: 'Restart to Update…',
};

/** `updates` is null where the app cannot update itself (unpackaged runs). */
export function buildMenu({ isMac, isPackaged, updates, onOpen, onSettings, onOpenLogs, openExternal }) {
  const settings = { label: isMac ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: onSettings };
  const update = updates && {
    label: UPDATE_LABELS[updates.status],
    enabled: updates.status === 'idle' || updates.status === 'ready',
    click: updates.onClick,
  };
  const template = [
    ...(isMac
      ? [{
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          ...(update ? [update] : []),
          { type: 'separator' },
          settings,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: onOpen },
        ...(isMac ? [] : [{ type: 'separator' }, settings]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'OpenReader Documentation', click: () => openExternal(DOCS_URL) },
        { label: 'Open Logs Folder', click: onOpenLogs },
        ...(update && !isMac ? [{ type: 'separator' }, update] : []),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
