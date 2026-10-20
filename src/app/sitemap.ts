import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/shared/urls';

// BASE_URL is set per deployment at runtime, so these URLs cannot be built in.
export const dynamic = 'force-dynamic';

/** The public, indexable pages. Everything under /app sits behind sign-in. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getSiteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/download`, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${origin}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/ios-privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/desktop-privacy`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
