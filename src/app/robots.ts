import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/shared/urls';

// BASE_URL is set per deployment at runtime, so these URLs cannot be built in.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/app', '/api/'] },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
