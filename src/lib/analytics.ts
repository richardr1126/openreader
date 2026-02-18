'use client';

/**
 * Analytics Consent Management
 * 
 * Handles state for the Cookie Consent Banner and Vercel Analytics opt-out.
 */

const CONSENT_KEY = 'cookie-consent';
export const CONSENT_CHANGED_EVENT = 'openreader:consentChanged';

export type ConsentState = 'undecided' | 'accepted' | 'declined';

export function getConsentState(): ConsentState {
  if (typeof window === 'undefined') return 'undecided';

  // Check for Global Privacy Control (GPC)
  if (window.navigator?.globalPrivacyControl) {
    return 'declined';
  }

  const val = localStorage.getItem(CONSENT_KEY);
  if (val === 'accepted' || val === 'declined') return val;

  return 'undecided';
}

export function setConsentState(state: 'accepted' | 'declined') {
  if (typeof window === 'undefined') return;
  // GPC must be treated as an opt-out signal regardless of prior/local choice.
  const effectiveState = window.navigator?.globalPrivacyControl ? 'declined' : state;
  localStorage.setItem(CONSENT_KEY, effectiveState);
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));

  // Apply the choice immediately
  if (effectiveState === 'declined') {
    disableAnalytics();
  } else {
    enableAnalytics();
  }
}

declare global {
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
  interface Window {
    va?: {
      disable?: () => void;
      enable?: () => void;
    } | ((...args: unknown[]) => void);
  }
}

/**
 * Opt-out of Vercel Analytics.
 * This sets the flag that @vercel/analytics respects.
 */
export function disableAnalytics() {
  if (typeof window === 'undefined') return;
  const va = window.va;
  if (va && typeof va === 'object' && typeof va.disable === 'function') {
    va.disable();
  }
}

/**
 * Re-enable Vercel Analytics (Opt-in).
 */
export function enableAnalytics() {
  if (typeof window === 'undefined') return;
  const va = window.va;
  if (va && typeof va === 'object' && typeof va.enable === 'function') {
    va.enable();
  }
}
