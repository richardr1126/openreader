import { expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';

const baseURL = 'http://localhost:3003';

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/**
 * The seeded administrator, for provider setup the journey under test does not
 * cover. Contexts share Playwright's keep-alive pool. Close each admin request's
 * connection so no idle admin socket survives the browser journey and races
 * the server's keep-alive timeout when cleanup reuses it.
 */
export async function signInAdmin(playwright: PlaywrightWorkerArgs['playwright']) {
  const request = async <T>(storageState: StorageState | undefined, send: (request: APIRequestContext) => Promise<T>) => {
    const context = await playwright.request.newContext({
      baseURL, storageState, extraHTTPHeaders: { Connection: 'close' },
    });
    try {
      return await send(context);
    } finally {
      await context.dispose();
    }
  };
  const storageState = await request(undefined, async (context) => {
    const signIn = await context.post('/api/auth/sign-in/email', {
      headers: { Origin: baseURL },
      data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' },
    });
    expect(signIn.ok()).toBe(true);
    return context.storageState();
  });

  return {
    cookies: storageState.cookies,
    createProvider: (data: Record<string, unknown>) => request(storageState, async (context) => {
      const created = await context.post('/api/admin/providers', { data });
      expect(created.status()).toBe(201);
      return (await created.json()).provider as { id: string; slug: string };
    }),
    deleteProvider: (id: string) => request(storageState, async (context) => {
      const deleted = await context.delete(`/api/admin/providers/${id}`);
      expect(deleted.ok()).toBe(true);
    }),
  };
}
