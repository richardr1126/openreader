'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Badge, Button, Section, type BadgeTone } from '@/components/ui';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  evaluateBrowserChecks,
  type SystemCheckItem,
  type SystemCheckReport,
  type SystemCheckStatus,
  type WorkerProbeResult,
} from '@/lib/shared/system-check';

const PROBE_TIMEOUT_MS = 4_000;

const STATUS_BADGE: Record<SystemCheckStatus, { tone: BadgeTone; label: string }> = {
  ok: { tone: 'accent', label: 'OK' },
  warn: { tone: 'foreground', label: 'Check' },
  error: { tone: 'danger', label: 'Fix' },
};

// A no-cors request resolves (opaque) when the worker answers and rejects when the
// browser cannot connect, which is exactly what playback audio depends on.
async function probeWorkerFromBrowser(workerPublicUrl: string): Promise<WorkerProbeResult> {
  try {
    await fetch(new URL('/health/ready', workerPublicUrl), {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return 'reachable';
  } catch {
    return 'unreachable';
  }
}

async function loadChecks(): Promise<SystemCheckItem[]> {
  const res = await fetch('/api/admin/system-check', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const report = (await res.json()) as SystemCheckReport;
  const workerProbe = report.workerPublicUrl ? await probeWorkerFromBrowser(report.workerPublicUrl) : null;
  return [
    ...report.checks,
    ...evaluateBrowserChecks({
      pageOrigin: window.location.origin,
      baseUrl: report.baseUrl,
      workerPublicUrl: report.workerPublicUrl,
      workerProbe,
    }),
  ];
}

export function AdminSystemPanel() {
  const { data: session } = useAuthSession();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: queryKeys.admin(session?.user?.id ?? 'no-session', 'system-check'),
    queryFn: loadChecks,
    enabled: Boolean(session?.user?.id),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!error) return;
    console.error('[AdminSystemPanel] load failed:', error);
    toast.error('Failed to run system check');
  }, [error]);

  const problems = data?.filter((item) => item.status !== 'ok').length ?? 0;

  return (
    <Section
      variant="group"
      title="System check"
      subtitle={
        data
          ? (problems === 0 ? 'Everything checked is working.' : `${problems} item${problems === 1 ? '' : 's'} need attention.`)
          : 'Checks the worker, storage, providers, and the addresses this browser uses.'
      }
      action={(
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Checking…' : 'Run again'}
        </Button>
      )}
    >
      {data ? (
        <ul className="divide-y divide-line-soft !p-0" aria-label="System check results">
          {data.map((item) => {
            const badge = STATUS_BADGE[item.status];
            return (
              <li key={item.id} className="px-3 py-2.5" data-status={item.status}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">{item.label}</span>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-soft">{item.detail}</p>
                {item.fix ? <p className="mt-1 text-xs text-faint">{item.fix}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-soft" aria-busy={isFetching}>{error ? 'The check could not run.' : 'Running checks…'}</p>
      )}
    </Section>
  );
}
