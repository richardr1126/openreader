'use client';

import { Transition } from '@headlessui/react';
import { ExternalLinkIcon, XIcon } from '@/components/icons/Icons';
import { IconButton } from '@/components/ui';

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/eJTYjDwV';

/**
 * Full-width strip between the library toolbar and its panes. It collapses its
 * own height on enter/exit so the library slides with it instead of jumping.
 */
export function IosBetaBanner({ show, onDismiss }: { show: boolean; onDismiss: () => void }) {
  return (
    <Transition
      show={show}
      appear
      as="div"
      className="grid shrink-0 transition-[grid-template-rows,opacity] duration-slow ease-standard"
      enterFrom="grid-rows-[0fr] opacity-0"
      enterTo="grid-rows-[1fr] opacity-100"
      leaveFrom="grid-rows-[1fr] opacity-100"
      leaveTo="grid-rows-[0fr] opacity-0"
    >
      <div className="min-h-0 overflow-hidden">
        <aside
          aria-label="OpenReader for iOS beta"
          className="flex items-center gap-2.5 border-b border-line-soft bg-accent-wash px-3 py-1.5 sm:gap-3"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent-line bg-surface text-accent" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
              <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
              <path d="M10.5 18.5h3" strokeLinecap="round" />
            </svg>
          </span>
          <p className="min-w-0 flex-1 truncate text-[13px] leading-tight text-foreground">
            <span className="font-semibold sm:hidden">OpenReader for iOS</span>
            <span className="hidden font-semibold sm:inline">OpenReader for iOS is coming soon</span>
            <span className="hidden text-soft md:inline">
              {' · '}On-device speech from many voice models, plus voice cloning, with Apple&rsquo;s Core AI.
            </span>
          </p>
          <a
            href={TESTFLIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-accent-line bg-surface px-2.5 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="sm:hidden">Join beta</span>
            <span className="hidden sm:inline">Join iOS beta</span>
            <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden />
          </a>
          <IconButton onClick={onDismiss} size="sm" aria-label="Dismiss iOS beta banner">
            <XIcon className="h-4 w-4" aria-hidden />
          </IconButton>
        </aside>
      </div>
    </Transition>
  );
}
