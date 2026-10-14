import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/shared/urls';

/** The public, indexable pages. Everything under /app sits behind sign-in. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getSiteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/ios-privacy`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
