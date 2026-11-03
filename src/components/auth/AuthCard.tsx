import type { ReactNode } from 'react';
import Link from 'next/link';
import { Surface } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';

/** The one frame around every sign-in, account and app approval screen. */
export function AuthCard({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto flex min-h-full w-full max-w-md items-center px-4 py-8">
    <div className="w-full space-y-4">
      <Link href="/app" className="flex items-center justify-center gap-2 text-base font-bold tracking-tight text-foreground">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="h-6 w-6 shrink-0" aria-hidden="true" />
        OpenReader
      </Link>
      <Surface elevation="3" className="space-y-5 p-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <div className="text-sm text-soft">{description}</div>}
        </div>
        {children}
      </Surface>
    </div>
  </div></div>;
}

export function AuthFooter({ children }: { children: ReactNode }) {
  return <div className="space-y-2 border-t border-line pt-4 text-center text-xs text-soft">{children}</div>;
}

export function AuthFallback() {
  return <div className="flex min-h-0 flex-1 items-center justify-center"><LoadingSpinner className="h-6 w-6 text-soft" /></div>;
}
