'use client';

import Link from 'next/link';
import { PLATFORMS } from './desktop-downloads';
import { useVisitorPlatform } from './useVisitorPlatform';

/** Links to /download, named for the visitor's computer once it is known. */
export function DownloadLink({ className }: { className: string }) {
  const { os } = useVisitorPlatform();
  const label = os === 'mac' || os === 'windows' || os === 'linux' ? `Download for ${PLATFORMS[os].name}` : 'Download the app';
  return <Link href="/download" className={className}>{label}</Link>;
}
