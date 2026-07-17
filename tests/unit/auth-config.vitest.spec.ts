import { describe, expect, test } from 'vitest';
import { getAuthBaseUrl, getOidcAuthConfig, getOidcPublicAuthConfig, getRequiredAuthEnv, isAnonymousAuthSessionsEnabled, isGithubAuthEnabled } from '../../src/lib/server/auth/config';
import { withEnv } from './support/env';

describe('auth config contract', () => {
  test('reads required AUTH_SECRET and BASE_URL', async () => {
    await withEnv(
      {
        AUTH_SECRET: 'unit-secret-2',
        BASE_URL: 'http://localhost:3003',
      },
      async () => {
        expect(getRequiredAuthEnv()).toEqual({
          authSecret: 'unit-secret-2',
          baseUrl: 'http://localhost:3003',
        });
        expect(getAuthBaseUrl()).toBe('http://localhost:3003');
      },
    );
  });

  test.each([
    { envValue: undefined, expected: false },
    { envValue: 'true', expected: true },
    { envValue: 'false', expected: false },
    { envValue: '1', expected: false },
    { envValue: 'TRUE', expected: true },
  ])(
    'anonymous sessions honor strict boolean parsing when auth is enabled (value: $envValue)',
    async ({ envValue, expected }) => {
      await withEnv(
        {
          AUTH_SECRET: 'unit-secret',
          BASE_URL: 'http://localhost:3003',
          USE_ANONYMOUS_AUTH_SESSIONS: envValue,
        },
        async () => {
          expect(isAnonymousAuthSessionsEnabled()).toBe(expected);
        },
      );
    },
  );

  test('anonymous session config returns false for non-true values', async () => {
    await withEnv(
      {
        AUTH_SECRET: 'unit-secret',
        BASE_URL: 'http://localhost:3003',
        USE_ANONYMOUS_AUTH_SESSIONS: '1',
      },
      async () => {
        expect(isAnonymousAuthSessionsEnabled()).toBe(false);
      },
    );
  });

  test.each([
    {
      title: 'returns false when GitHub client id is missing',
      env: {
        AUTH_SECRET: 'unit-secret',
        BASE_URL: 'http://localhost:3003',
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: 'secret',
      },
      expected: false,
    },
    {
      title: 'returns false when GitHub client secret is missing',
      env: {
        AUTH_SECRET: 'unit-secret',
        BASE_URL: 'http://localhost:3003',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: undefined,
      },
      expected: false,
    },
    {
      title: 'returns true when auth is enabled and GitHub credentials are present',
      env: {
        AUTH_SECRET: 'unit-secret',
        BASE_URL: 'http://localhost:3003',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
      },
      expected: true,
    },
  ])('$title', async ({ env, expected }) => {
    await withEnv(env, async () => {
      expect(isGithubAuthEnabled()).toBe(expected);
    });
  });

  test.each([
    {
      title: 'returns null when OIDC client id is missing',
      env: {
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
      },
    },
    {
      title: 'returns null when OIDC client secret is missing',
      env: {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: undefined,
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
      },
    },
    {
      title: 'returns null when OIDC discovery URL is missing',
      env: {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: undefined,
      },
    },
  ])('$title', async ({ env }) => {
    await withEnv(env, async () => {
      expect(getOidcAuthConfig()).toBeNull();
      expect(getOidcPublicAuthConfig()).toBeNull();
    });
  });

  test('OIDC config applies defaults for optional values', async () => {
    await withEnv(
      {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
      },
      async () => {
        expect(getOidcAuthConfig()).toEqual({
          providerId: 'oidc',
          providerName: 'SSO',
          clientId: 'id',
          clientSecret: 'secret',
          discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
          scopes: ['openid', 'profile', 'email'],
        });
      },
    );
  });

  test('OIDC config honors optional overrides and scope parsing', async () => {
    await withEnv(
      {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
        OIDC_PROVIDER_ID: 'pocket-id',
        OIDC_PROVIDER_NAME: 'Pocket ID',
        OIDC_SCOPES: 'openid, profile email',
      },
      async () => {
        const config = getOidcAuthConfig();
        expect(config).toMatchObject({
          providerId: 'pocket-id',
          providerName: 'Pocket ID',
          scopes: ['openid', 'profile', 'email'],
        });
      },
    );
  });

  test('OIDC public config exposes only provider id and name', async () => {
    await withEnv(
      {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
        OIDC_PROVIDER_NAME: 'Pocket ID',
      },
      async () => {
        expect(getOidcPublicAuthConfig()).toEqual({
          providerId: 'oidc',
          providerName: 'Pocket ID',
        });
      },
    );
  });

  test('OIDC config rejects provider ids that are not URL-safe', async () => {
    await withEnv(
      {
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_DISCOVERY_URL: 'https://idp.example.com/.well-known/openid-configuration',
        OIDC_PROVIDER_ID: 'bad/provider id',
      },
      async () => {
        expect(() => getOidcAuthConfig()).toThrow(/OIDC_PROVIDER_ID/);
      },
    );
  });
});
