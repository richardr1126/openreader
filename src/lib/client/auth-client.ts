import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";

// Factory function to create auth client with specific baseUrl
function createAuthClientWithUrl(baseUrl: string) {
  return createAuthClient({
    baseURL: baseUrl,
    plugins: [anonymousClient()],
  });
}

// Cache for auth client instances by baseUrl
const clientCache = new Map<string, ReturnType<typeof createAuthClientWithUrl>>();

function resolveAuthClientBaseUrl(baseUrl: string | null): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    // Always use same-origin in the browser so local hostname variants
    // (localhost vs LAN IP) do not break cookie/session bootstrap.
    return window.location.origin;
  }

  if (baseUrl) return baseUrl;

  throw new Error(
    'Cannot create auth client without baseUrl in a non-browser context. ' +
    'Use useAuthConfig() in components to get the properly configured baseUrl.'
  );
}

/**
 * Factory function to get auth client with specific baseUrl.
 * In components, prefer reading `baseUrl` from `useAuthConfig()` and then calling `getAuthClient(baseUrl)`.
 * @param baseUrl - Server-provided auth URL; in the browser we use same-origin automatically.
 */
export function getAuthClient(baseUrl: string | null) {
  const resolvedBaseUrl = resolveAuthClientBaseUrl(baseUrl);

  if (!clientCache.has(resolvedBaseUrl)) {
    clientCache.set(resolvedBaseUrl, createAuthClientWithUrl(resolvedBaseUrl));
  }

  return clientCache.get(resolvedBaseUrl)!;
}
