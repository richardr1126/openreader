'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopArch, DesktopPlatform } from './desktop-downloads';

export type VisitorOs = DesktopPlatform | 'ios' | 'android';

interface UserAgentData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

const userAgentData = () => (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;

function detectOs(): VisitorOs | null {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (userAgentData()?.platform || navigator.platform || '').toLowerCase();
  // iPadOS reports itself as a Mac; touch gives it away.
  if (/iphone|ipad|ipod/.test(ua) || (platform.startsWith('mac') && navigator.maxTouchPoints > 1)) return 'ios';
  if (ua.includes('android')) return 'android';
  if (platform.startsWith('mac') || ua.includes('mac os')) return 'mac';
  if (platform.startsWith('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux') || ua.includes('cros')) return 'linux';
  return null;
}

const subscribe = () => () => {};

/**
 * The visitor's operating system and, where Chromium reports it, architecture.
 * The server render and hydration see null, so the page renders generically
 * first. Without an architecture hint, Macs are assumed to be Apple silicon and
 * everything else x64, the common case for each.
 */
export function useVisitorPlatform(): { os: VisitorOs | null; arch: DesktopArch | null } {
  const os = useSyncExternalStore(subscribe, detectOs, () => null);
  const [hinted, setHinted] = useState<DesktopArch | null>(null);

  useEffect(() => {
    let cancelled = false;
    userAgentData()
      ?.getHighEntropyValues?.(['architecture'])
      .then(({ architecture }) => {
        if (!cancelled && architecture) setHinted(architecture === 'arm' ? 'arm64' : 'x64');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const arch = hinted ?? (os === 'mac' ? 'arm64' : os === 'windows' || os === 'linux' ? 'x64' : null);
  return { os, arch };
}
