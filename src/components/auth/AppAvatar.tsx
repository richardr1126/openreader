'use client';
import { useState } from 'react';

/** A verified client's logo, or a neutral letter for every other client and for a logo that won't load. */
export function AppAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const frame = 'h-10 w-10 shrink-0 rounded-md border border-line bg-surface-sunken';
  if (logoUrl && failedUrl !== logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={`${name} logo`} className={`${frame} object-contain`} onError={() => setFailedUrl(logoUrl)} />;
  }
  return <span aria-hidden="true" className={`${frame} inline-flex items-center justify-center text-sm font-semibold text-soft`}>{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</span>;
}
