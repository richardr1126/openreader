'use client';

import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';
import {
  CONSENT_CHANGED_EVENT,
  disableAnalytics,
  enableAnalytics,
  getConsentState,
  isAnalyticsAllowed,
} from '@/lib/client/analytics';

export function ConsentAwareAnalytics() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => {
      const allowAnalytics = isAnalyticsAllowed(getConsentState());
      setEnabled(allowAnalytics);
      if (allowAnalytics) {
        enableAnalytics();
      } else {
        disableAnalytics();
      }
      setReady(true);
    };

    sync();
    window.addEventListener(CONSENT_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);

    return () => {
      window.removeEventListener(CONSENT_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (!ready || !enabled) return null;
  return <Analytics />;
}
