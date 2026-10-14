// Documents the owner opens from outside the page: File → Open…, a file
// association, or the Dock. The shell reads them and hands them to the library
// page through the preload bridge, which uploads them with the same flow as a
// drop (v5/DESKTOP_SINGLE_OWNER.md). There is no separate upload route.

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** What the library accepts, by extension. The page infers each file's type from its name. */
export const DOCUMENT_EXTENSIONS = ['pdf', 'epub', 'txt', 'md', 'docx'];

function isDocumentPath(file) {
  return DOCUMENT_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());
}

/** Document paths in a command line (Windows and Linux pass opened files as arguments). */
export function documentPathsInArgv(argv) {
  return argv.filter((arg) => {
    if (arg.startsWith('-') || !isDocumentPath(arg)) return false;
    try {
      return statSync(arg).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Holds opened documents until a library page listens, then delivers them. One
 * page listens at a time; navigating away or closing stops it listening.
 */
export class DocumentInbox {
  #pending = [];
  #listener = null;
  #watched = new WeakSet();
  #openLibrary;

  /** `openLibrary` loads the library page when nothing is listening. */
  constructor({ openLibrary }) {
    this.#openLibrary = openLibrary;
  }

  listen(contents) {
    this.#listener = contents;
    if (!this.#watched.has(contents)) {
      this.#watched.add(contents);
      // A full page load drops the page's listener without telling us.
      contents.on('did-navigate', () => this.unlisten(contents));
      contents.once('destroyed', () => this.unlisten(contents));
    }
    this.#flush();
  }

  unlisten(contents) {
    if (this.#listener === contents) this.#listener = null;
  }

  async open(paths) {
    const files = [];
    for (const file of paths.filter(isDocumentPath)) {
      if (!existsSync(file)) continue;
      const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      files.push({ name: path.basename(file), lastModified: stat.mtimeMs, bytes });
    }
    if (files.length === 0) return;
    this.#pending.push(...files);
    if (this.#listener) this.#flush();
    else this.#openLibrary();
  }

  #flush() {
    if (!this.#listener || this.#pending.length === 0) return;
    this.#listener.send('open-files', this.#pending);
    this.#pending = [];
  }
}
