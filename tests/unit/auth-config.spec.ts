import { test, expect } from '@playwright/test';
import { isAnonymousAuthSessionsEnabled, isGithubAuthEnabled } from '../../src/lib/server/auth/config';

const ORIGINAL_BASE_URL = process.env.BASE_URL;
const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_USE_ANON = process.env.USE_ANONYMOUS_AUTH_SESSIONS;
const ORIGINAL_GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const ORIGINAL_GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

function restoreEnv() {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = ORIGINAL_BASE_URL;

  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;

  if (ORIGINAL_USE_ANON === undefined) delete process.env.USE_ANONYMOUS_AUTH_SESSIONS;
  else process.env.USE_ANONYMOUS_AUTH_SESSIONS = ORIGINAL_USE_ANON;

  if (ORIGINAL_GITHUB_CLIENT_ID === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = ORIGINAL_GITHUB_CLIENT_ID;

  if (ORIGINAL_GITHUB_CLIENT_SECRET === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = ORIGINAL_GITHUB_CLIENT_SECRET;
}

function setAuthEnabledEnv() {
  process.env.BASE_URL = 'http://localhost:3003';
  process.env.AUTH_SECRET = 'test-secret';
}

test.describe('auth config anonymous-session flag', () => {
  test.afterEach(() => {
    restoreEnv();
  });

  test('returns false when auth is disabled', () => {
    delete process.env.BASE_URL;
    delete process.env.AUTH_SECRET;
    process.env.USE_ANONYMOUS_AUTH_SESSIONS = 'true';

    expect(isAnonymousAuthSessionsEnabled()).toBe(false);
  });

  test('defaults to false when env var is unset', () => {
    setAuthEnabledEnv();
    delete process.env.USE_ANONYMOUS_AUTH_SESSIONS;

    expect(isAnonymousAuthSessionsEnabled()).toBe(false);
  });

  test('returns true only when env var is true', () => {
    setAuthEnabledEnv();
    process.env.USE_ANONYMOUS_AUTH_SESSIONS = 'true';

    expect(isAnonymousAuthSessionsEnabled()).toBe(true);
  });

  test('returns false when env var is false', () => {
    setAuthEnabledEnv();
    process.env.USE_ANONYMOUS_AUTH_SESSIONS = 'false';

    expect(isAnonymousAuthSessionsEnabled()).toBe(false);
  });

  test('falls back to false for invalid values', () => {
    setAuthEnabledEnv();
    process.env.USE_ANONYMOUS_AUTH_SESSIONS = '1';

    expect(isAnonymousAuthSessionsEnabled()).toBe(false);
  });
});

test.describe('auth config github-auth flag', () => {
  test.afterEach(() => {
    restoreEnv();
  });

  test('returns false when auth is disabled', () => {
    delete process.env.BASE_URL;
    delete process.env.AUTH_SECRET;
    process.env.GITHUB_CLIENT_ID = 'some-id';
    process.env.GITHUB_CLIENT_SECRET = 'some-secret';

    expect(isGithubAuthEnabled()).toBe(false);
  });

  test('returns false when GITHUB_CLIENT_ID is missing', () => {
    setAuthEnabledEnv();
    delete process.env.GITHUB_CLIENT_ID;
    process.env.GITHUB_CLIENT_SECRET = 'some-secret';

    expect(isGithubAuthEnabled()).toBe(false);
  });

  test('returns false when GITHUB_CLIENT_SECRET is missing', () => {
    setAuthEnabledEnv();
    process.env.GITHUB_CLIENT_ID = 'some-id';
    delete process.env.GITHUB_CLIENT_SECRET;

    expect(isGithubAuthEnabled()).toBe(false);
  });

  test('returns false when both GitHub env vars are missing', () => {
    setAuthEnabledEnv();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    expect(isGithubAuthEnabled()).toBe(false);
  });

  test('returns true when auth is enabled and both GitHub env vars are set', () => {
    setAuthEnabledEnv();
    process.env.GITHUB_CLIENT_ID = 'some-id';
    process.env.GITHUB_CLIENT_SECRET = 'some-secret';

    expect(isGithubAuthEnabled()).toBe(true);
  });
});
