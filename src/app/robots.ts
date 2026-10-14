import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/shared/urls';

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/app', '/api/'] },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
