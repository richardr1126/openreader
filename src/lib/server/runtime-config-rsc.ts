import { cache } from 'react';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';

/**
 * Per-request cached runtime config accessor for React Server Components.
 * This avoids duplicate DB/runtime-config reads when multiple RSC layers
 * (e.g. layout + page) need the same config in one render.
 */
export const getResolvedRuntimeConfigForRsc = cache(async () => {
  if (typeof window !== 'undefined') {
    throw new Error('getResolvedRuntimeConfigForRsc must be called on the server');
  }
  return getResolvedRuntimeConfig();
});
