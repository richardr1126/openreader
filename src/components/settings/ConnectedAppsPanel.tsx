'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@/hooks/useAuthSession';
import { requestJson } from '@/lib/client/api/http';
import { Badge, Button } from '@/components/ui';
import { API_SCOPE_LABELS } from '@/lib/shared/api-scopes';

type App = { id: string; name: string; verifiedDomain: string | null; redirectDomains: string[]; scopes: string[]; createdAt: number };
export function ConnectedAppsPanel() {
  const { data: session } = useAuthSession();
  const client = useQueryClient();
  const key = ['connected-apps', session?.user.id];
  const query = useQuery({ queryKey: key, enabled: !!session?.user && !session.user.isAnonymous,
    queryFn: ({ signal }) => requestJson<{ data: App[] }>('/api/user/connected-apps', { signal }, 'Unable to load connected apps') });
  const disconnect = useMutation({ mutationFn: (id: string) => requestJson(`/api/user/connected-apps/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Unable to disconnect app'),
    onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  if (!session?.user || session.user.isAnonymous) return null;
  return <section aria-labelledby="connected-apps-heading" className="rounded-lg border border-line bg-background p-4 sm:p-5">
    <h3 id="connected-apps-heading" className="text-sm font-semibold">Connected apps</h3>
    <p className="mt-1 text-xs text-soft">Apps you approved share your compute limits. Disconnecting stops their access immediately.</p>
    {query.isPending ? <p role="status" className="mt-4 text-sm text-soft">Loading connected apps…</p>
      : query.isError ? <p role="alert" className="mt-4 text-sm text-danger">Unable to load connected apps.</p>
        : !query.data?.data.length ? <p className="mt-4 text-sm text-soft">No connected apps.</p>
          : <ul className="mt-4 divide-y divide-line">{query.data.data.map(app => <li key={app.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="text-sm font-semibold">{app.name}</h4><p className="mt-1 break-all text-xs text-soft">{app.redirectDomains.join(', ') || 'Device authorization'}</p></div>
              <Button variant="secondary" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate(app.id)}>Disconnect</Button></div>
            <div className="mt-2"><Badge>{app.verifiedDomain ?? 'Unverified app'}</Badge></div>
            <ul className="mt-2 space-y-1 text-xs text-soft">{app.scopes.map(scope => <li key={scope}>{API_SCOPE_LABELS[scope] || scope}</li>)}</ul>
          </li>)}</ul>}
    {disconnect.isError && <p role="alert" className="mt-3 text-sm text-danger">Unable to disconnect app. Try again.</p>}
  </section>;
}
