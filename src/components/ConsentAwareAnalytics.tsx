'use client';

import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';
import {
  CONSENT_CHANGED_EVENT,
  getConsentState,
  isAnalyticsAllowed,
} from '@/lib/client/analytics';

// The script stays loaded after consent is withdrawn, so every event checks
// the current consent before it is sent.
function dropWithoutConsent<T>(event: T): T | null {
  return isAnalyticsAllowed(getConsentState()) ? event : null;
}

export function ConsentAwareAnalytics() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => {
      setEnabled(isAnalyticsAllowed(getConsentState()));
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
  return <Analytics beforeSend={dropWithoutConsent} />;
}
