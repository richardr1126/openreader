#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = process.env.CHANGELOG_REPO || process.env.GITHUB_REPOSITORY || 'richardr1126/openreader';
const PUBLIC_BASE = (process.env.CHANGELOG_PUBLIC_BASE_URL || 'https://docs.openreader.richardr.dev').replace(/\/$/, '');
const OUTPUT_DIR = path.resolve('docs-site/static/changelog');
const RELEASES_DIR = path.join(OUTPUT_DIR, 'releases');
const MUTABLE_COUNT = Number(process.env.CHANGELOG_MUTABLE_COUNT || '3');
const FULL_MODE = process.argv.includes('--full') || process.env.CHANGELOG_FORCE_FULL === '1';

function normalizeTagSlug(tagName) {
  const normalized = String(tagName || '').trim().toLowerCase();
  const collapsed = normalized
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return collapsed || 'release';
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const aMs = Date.parse(a.published_at);
    const bMs = Date.parse(b.published_at);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return bMs - aMs;
    }
    return String(b.tag_name || '').localeCompare(String(a.tag_name || ''));
  });
}

function toManifestEntry(release) {
  return {
    tag_name: String(release.tag_name || ''),
    name: String(release.name || release.tag_name || ''),
    published_at: String(release.published_at || release.created_at || new Date().toISOString()),
    html_url: String(release.html_url || ''),
    prerelease: Boolean(release.prerelease),
    body_path: '',
  };
}

function toBodyRecord(release) {
  return {
    tag_name: String(release.tag_name || ''),
    name: String(release.name || release.tag_name || ''),
    published_at: String(release.published_at || release.created_at || new Date().toISOString()),
    html_url: String(release.html_url || ''),
    prerelease: Boolean(release.prerelease),
    body: String(release.body || ''),
  };
}

function applyBodyPath(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    const base = normalizeTagSlug(entry.tag_name);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count + 1}`;
    return { ...entry, body_path: `changelog/releases/${slug}.json` };
  });
}

async function fetchJson(url, { auth = false } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (auth && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchGitHubReleases() {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
    const data = await fetchJson(url, { auth: true });
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

async function fetchGitHubReleaseByTag(tagName) {
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tagName)}`;
  try {
    return await fetchJson(url, { auth: true });
  } catch {
    return null;
  }
}

async function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    const raw = await readFile(eventPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchRemoteManifest() {
  const url = `${PUBLIC_BASE}/changelog/manifest.json`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data?.releases)) return null;
    return data;
  } catch {
    return null;
  }
}

async function fetchRemoteBody(bodyPath) {
  const url = `${PUBLIC_BASE}/${bodyPath.replace(/^\/+/, '')}`;
  try {
    return await fetchJson(url);
  } catch {
    return null;
  }
}

async function loadRemoteState() {
  const manifestDoc = await fetchRemoteManifest();
  if (!manifestDoc) return null;
  const manifest = Array.isArray(manifestDoc.releases) ? manifestDoc.releases : [];
  const bodies = new Map();
  await Promise.all(manifest.map(async (entry) => {
    if (!entry?.body_path) return;
    const bodyDoc = await fetchRemoteBody(entry.body_path);
    if (bodyDoc && typeof bodyDoc.body === 'string') {
      bodies.set(entry.tag_name, bodyDoc);
    }
  }));
  return { manifest, bodies };
}

function isMutable(manifest, tagName) {
  const idx = manifest.findIndex((x) => x.tag_name === tagName);
  return idx >= 0 && idx < MUTABLE_COUNT;
}

async function buildState() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const payload = await readEventPayload();
  const releaseEvent = payload?.release;
  const releaseAction = payload?.action || '';

  const remoteState = await loadRemoteState();
  const shouldFull = FULL_MODE || !remoteState;

  if (shouldFull) {
    const releases = await fetchGitHubReleases();
    const filtered = releases.filter((r) => !r.draft);
    const entries = sortEntries(filtered.map(toManifestEntry));
    const entriesWithPath = applyBodyPath(entries);
    const bodies = new Map(filtered.map((r) => [r.tag_name, toBodyRecord(r)]));
    return { entries: entriesWithPath, bodies, mode: 'full' };
  }

  const manifest = sortEntries(remoteState.manifest.filter((x) => !!x?.tag_name));
  const bodies = new Map(remoteState.bodies);

  if (eventName === 'release' && releaseEvent?.tag_name) {
    const tagName = String(releaseEvent.tag_name);
    const isDraft = Boolean(releaseEvent.draft);
    const mutable = isMutable(manifest, tagName);

    if (releaseAction === 'deleted') {
      if (mutable) {
        const next = manifest.filter((entry) => entry.tag_name !== tagName);
        bodies.delete(tagName);
        return { entries: applyBodyPath(sortEntries(next)), bodies, mode: 'incremental-delete' };
      }
      return { entries: applyBodyPath(manifest), bodies, mode: 'incremental-delete-skipped' };
    }

    if (!isDraft) {
      const incoming = toManifestEntry(releaseEvent);
      const existingIdx = manifest.findIndex((entry) => entry.tag_name === tagName);
      if (existingIdx === -1 || mutable || existingIdx < MUTABLE_COUNT) {
        if (existingIdx >= 0) manifest.splice(existingIdx, 1);
        manifest.push(incoming);
        bodies.set(tagName, toBodyRecord(releaseEvent));
      }
    }

    return { entries: applyBodyPath(sortEntries(manifest)), bodies, mode: 'incremental-upsert' };
  }

  const dispatchInputs = payload?.inputs;
  const dispatchTag = String(dispatchInputs?.release_tag || '').trim();
  const dispatchAction = String(dispatchInputs?.release_action || '').trim().toLowerCase();

  if (eventName === 'workflow_dispatch' && dispatchTag) {
    if (dispatchAction === 'deleted') {
      const mutable = isMutable(manifest, dispatchTag);
      if (mutable) {
        const next = manifest.filter((entry) => entry.tag_name !== dispatchTag);
        bodies.delete(dispatchTag);
        return { entries: applyBodyPath(sortEntries(next)), bodies, mode: 'incremental-delete' };
      }
      return { entries: applyBodyPath(manifest), bodies, mode: 'incremental-delete-skipped' };
    }

    const release = await fetchGitHubReleaseByTag(dispatchTag);
    if (release && !release.draft) {
      const incoming = toManifestEntry(release);
      const existingIdx = manifest.findIndex((entry) => entry.tag_name === dispatchTag);
      const mutable = isMutable(manifest, dispatchTag);
      if (existingIdx === -1 || mutable || existingIdx < MUTABLE_COUNT) {
        if (existingIdx >= 0) manifest.splice(existingIdx, 1);
        manifest.push(incoming);
        bodies.set(dispatchTag, toBodyRecord(release));
      }
    }

    return { entries: applyBodyPath(sortEntries(manifest)), bodies, mode: 'incremental-upsert' };
  }

  return { entries: applyBodyPath(manifest), bodies, mode: 'mirror' };
}

async function writeState({ entries, bodies, mode }) {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(RELEASES_DIR, { recursive: true });

  const manifest = {
    generated_at: new Date().toISOString(),
    source: `https://github.com/${REPO}/releases`,
    mutable_window: MUTABLE_COUNT,
    mode,
    releases: entries,
  };

  for (const entry of entries) {
    let body = bodies.get(entry.tag_name);
    if (!body) {
      body = {
        tag_name: entry.tag_name,
        name: entry.name,
        published_at: entry.published_at,
        html_url: entry.html_url,
        prerelease: entry.prerelease,
        body: '',
      };
    }
    const outPath = path.resolve('docs-site/static', entry.body_path);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${entries.length} changelog releases (${mode})`);
}

const state = await buildState();
await writeState(state);
