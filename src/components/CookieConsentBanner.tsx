'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getConsentState, setConsentState } from '@/lib/analytics';
import { Transition } from '@headlessui/react';

export function CookieConsentBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Check consent on mount
    const consent = getConsentState();
    if (consent === 'undecided') {
      // Small delay to prevent layout thrashing on load
      const timer = setTimeout(() => setShow(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    setConsentState('accepted');
    setShow(false);
  };

  const handleDecline = () => {
    setConsentState('declined');
    setShow(false);
  };

  if (!show) return null;

  return (
    <Transition
      as="div"
      show={show}
      enter="transition ease-out duration-300 transform"
      enterFrom="translate-y-full opacity-0"
      enterTo="translate-y-0 opacity-100"
      leave="transition ease-in duration-200 transform"
      leaveFrom="translate-y-0 opacity-100"
      leaveTo="translate-y-full opacity-0"
      className="fixed bottom-0 left-0 right-0 z-[60] p-4 md:p-6"
    >
      <div className="mx-auto max-w-5xl rounded-xl border border-offbase bg-base p-5 shadow-2xl md:flex md:items-center md:justify-between md:gap-8">
        <div className="mb-4 md:mb-0">
          <h3 className="mb-2 text-lg font-bold">
            🍪 We use cookies
          </h3>
          <p className="text-sm leading-relaxed text-foreground/90">
            We use strictly necessary cookies for authentication and optional cookies for anonymous analytics
            to improve the app. See our <Link href="/privacy" className="font-medium text-accent hover:underline">Privacy Policy</Link> for details.
          </p>
        </div>

        <div className="flex flex-col gap-3 min-w-fit sm:flex-row">
          <button
            onClick={handleDecline}
            className="whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium text-foreground hover:bg-offbase focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            Decline Non-Essential
          </button>
          <button
            onClick={handleAccept}
            className="whitespace-nowrap rounded-lg bg-accent px-6 py-2.5 text-sm font-bold text-background hover:bg-secondary-accent shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-transform hover:scale-[1.02]"
          >
            Accept All
          </button>
        </div>
      </div>
    </Transition>
  );
}
