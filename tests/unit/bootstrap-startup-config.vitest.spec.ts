import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  evaluateStartupConfig,
  formatConfigProblems,
} from '../../packages/bootstrap/src/preflight.mjs';
import {
  applyEmbeddedPlaybackSecret,
  deriveEmbeddedPlaybackSecret,
} from '../../packages/bootstrap/src/runtime-secrets.mjs';
import {
  detectPreV5Database,
  formatV4UpgradeNotice,
} from '../../packages/bootstrap/src/v4-upgrade.mjs';

const validEnv = { AUTH_SECRET: 'a-private-auth-secret', BASE_URL: 'http://localhost:3003' };
const messages = (entries: Array<{ message: string }>) => entries.map((entry) => entry.message);

describe('embedded playback secret', () => {
  test('is stable and domain separated from AUTH_SECRET', () => {
    const first = deriveEmbeddedPlaybackSecret('auth-secret');
    expect(deriveEmbeddedPlaybackSecret('auth-secret')).toBe(first);
    expect(deriveEmbeddedPlaybackSecret(' auth-secret ')).toBe(first);
    expect(first).not.toContain('auth-secret');
    expect(deriveEmbeddedPlaybackSecret('other-secret')).not.toBe(first);
  });

  test('fills a missing value from AUTH_SECRET', () => {
    const env: Record<string, string | undefined> = { AUTH_SECRET: 'auth-secret' };
    expect(applyEmbeddedPlaybackSecret(env)).toBe(true);
    expect(env.TTS_PLAYBACK_TOKEN_SECRET).toBe(deriveEmbeddedPlaybackSecret('auth-secret'));
  });

  test('never overrides an explicit value so existing caches keep their identity', () => {
    const env: Record<string, string | undefined> = {
      AUTH_SECRET: 'auth-secret',
      TTS_PLAYBACK_TOKEN_SECRET: 'operator-chosen',
    };
    expect(applyEmbeddedPlaybackSecret(env)).toBe(false);
    expect(env.TTS_PLAYBACK_TOKEN_SECRET).toBe('operator-chosen');
  });

  test('treats a blank value as unset and does nothing without AUTH_SECRET', () => {
    const blank: Record<string, string | undefined> = { AUTH_SECRET: 'auth-secret', TTS_PLAYBACK_TOKEN_SECRET: '  ' };
    expect(applyEmbeddedPlaybackSecret(blank)).toBe(true);
    const noAuth: Record<string, string | undefined> = {};
    expect(applyEmbeddedPlaybackSecret(noAuth)).toBe(false);
    expect(noAuth.TTS_PLAYBACK_TOKEN_SECRET).toBeUndefined();
  });
});

describe('startup configuration preflight', () => {
  test('accepts a minimal embedded configuration without warnings', () => {
    expect(evaluateStartupConfig(validEnv)).toEqual({ errors: [], warnings: [] });
  });

  test('reports every blocking problem in one pass', () => {
    const result = evaluateStartupConfig({ COMPUTE_WORKER_URL: 'http://worker:8081' });
    expect(messages(result.errors)).toEqual([
      'AUTH_SECRET is not set.',
      'BASE_URL is not set.',
      expect.stringContaining('COMPUTE_WORKER_TOKEN is required'),
      expect.stringContaining('COMPUTE_CREDENTIAL_BROKER_TOKEN is required'),
      expect.stringContaining('TTS_PLAYBACK_TOKEN_SECRET is required'),
    ]);
    const text = formatConfigProblems(result);
    expect(text).toContain('these are fixed');
    expect(text).toContain('openssl rand -base64 32');
  });

  test('rejects an invalid BASE_URL', () => {
    expect(messages(evaluateStartupConfig({ ...validEnv, BASE_URL: 'localhost:3003' }).errors))
      .toEqual([expect.stringContaining('BASE_URL is not a valid http(s) URL')]);
  });

  test('requires nats-server only for the embedded worker', () => {
    expect(messages(evaluateStartupConfig(validEnv, { hasNatsBinary: false }).errors))
      .toEqual([expect.stringContaining('nats-server')]);
    expect(evaluateStartupConfig({
      ...validEnv,
      COMPUTE_WORKER_URL: 'http://worker:8081',
      COMPUTE_WORKER_TOKEN: 't',
      COMPUTE_CREDENTIAL_BROKER_TOKEN: 'b',
      TTS_PLAYBACK_TOKEN_SECRET: 's',
    }, { hasNatsBinary: false }).errors).toEqual([]);
  });

  test('warns that ADMIN_EMAILS is ignored', () => {
    expect(messages(evaluateStartupConfig({ ...validEnv, ADMIN_EMAILS: 'me@example.com' }).warnings))
      .toEqual(['ADMIN_EMAILS is set but no longer used in v5.']);
  });

  test('warns when off-localhost playback would use a loopback worker address', () => {
    const lan = { ...validEnv, BASE_URL: 'http://192.168.0.20:3003' };
    expect(messages(evaluateStartupConfig(lan).warnings))
      .toEqual([expect.stringContaining('only works in a browser on this machine')]);
    expect(evaluateStartupConfig({ ...lan, COMPUTE_WORKER_PUBLIC_URL: 'http://192.168.0.20:8081' }).warnings)
      .toEqual([]);
  });

  test('warns when the explicit public worker URL is loopback for a remote app', () => {
    const lan = { ...validEnv, BASE_URL: 'http://192.168.0.20:3003' };
    expect(messages(evaluateStartupConfig({ ...lan, COMPUTE_WORKER_PUBLIC_URL: 'http://127.0.0.1:8081' }).warnings))
      .toEqual([expect.stringContaining('only works in a browser on this machine')]);
  });

  test('does not treat the unspecified address as the local machine', () => {
    const exposed = evaluateStartupConfig({
      ...validEnv,
      BASE_URL: 'http://0.0.0.0:3003',
      AUTH_SECRET: 'local-openreader-auth-secret-change-me',
    });
    expect(messages(exposed.warnings)).toEqual([
      expect.stringContaining('only works in a browser on this machine'),
      expect.stringContaining('AUTH_SECRET is still the published example value'),
    ]);
  });

  test('warns about https pages loading http worker audio, except on loopback', () => {
    const https = { ...validEnv, BASE_URL: 'https://reader.example.com' };
    expect(messages(evaluateStartupConfig({ ...https, COMPUTE_WORKER_PUBLIC_URL: 'http://reader.example.com:8081' }).warnings))
      .toEqual([expect.stringContaining('mixed content')]);
    expect(evaluateStartupConfig({ ...https, COMPUTE_WORKER_PUBLIC_URL: 'https://audio.example.com' }).warnings)
      .toEqual([]);
  });

  test('flags published example secrets only when the app is not on localhost', () => {
    const examples = {
      AUTH_SECRET: 'local-openreader-auth-secret-change-me',
      COMPUTE_CREDENTIAL_BROKER_TOKEN: 'local-credential-broker-token',
    };
    expect(evaluateStartupConfig({ ...validEnv, ...examples }).warnings).toEqual([]);
    const exposed = evaluateStartupConfig({
      ...validEnv,
      ...examples,
      BASE_URL: 'https://reader.example.com',
      COMPUTE_WORKER_PUBLIC_URL: 'https://audio.example.com',
    });
    expect(messages(exposed.warnings)).toEqual([
      expect.stringContaining('AUTH_SECRET is still the published example value'),
      expect.stringContaining('COMPUTE_CREDENTIAL_BROKER_TOKEN is still the published example value'),
    ]);
  });
});

describe('v4 upgrade detection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'openreader-v4-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({ SQLITE_DB_PATH: path.join(dir, 'sqlite3.db') });

  test('a fresh install is not an upgrade', async () => {
    expect(await detectPreV5Database({ workspaceRoot: dir, env: env() })).toBe(false);
  });

  test('a database with the v4 audiobook tables is an upgrade', async () => {
    const sqlite = new BetterSqlite3(env().SQLITE_DB_PATH);
    sqlite.exec('CREATE TABLE audiobooks (id text primary key)');
    sqlite.close();
    expect(await detectPreV5Database({ workspaceRoot: dir, env: env() })).toBe(true);
  });

  test('a migrated v5 database is not an upgrade', async () => {
    const sqlite = new BetterSqlite3(env().SQLITE_DB_PATH);
    sqlite.exec('CREATE TABLE user (id text primary key)');
    sqlite.close();
    expect(await detectPreV5Database({ workspaceRoot: dir, env: env() })).toBe(false);
  });

  test('never throws when the database cannot be read', async () => {
    expect(await detectPreV5Database({
      workspaceRoot: dir,
      env: { POSTGRES_URL: 'postgres://nobody@127.0.0.1:1/none' },
    })).toBe(false);
  });

  test('the notice states the destructive parts and the compute-worker requirements', () => {
    const notice = formatV4UpgradeNotice();
    expect(notice).toContain('cannot be reversed');
    expect(notice).toContain('audiobooks');
    expect(notice).toContain('ADMIN_EMAILS');
    expect(notice).toContain('8081');
    expect(notice).toContain('COMPUTE_WORKER_PUBLIC_URL');
    expect(notice).toContain('/deploy/upgrade-from-v4');
  });
});
