'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Badge, Button, Field, Input, Surface } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { getAuthClient } from '@/lib/client/auth-client';
import { requestJson } from '@/lib/client/api/http';
import { API_SCOPE_LABELS } from '@/lib/shared/api-scopes';

type RequestInfo = { name: string; scopes: string[]; destination: string; clientId: string };
export function OAuthConsentScreen({ device = false }: { device?: boolean }) {
  const search = useSearchParams();
  const query = search.toString();
  const { data: session, isPending } = useAuthSession();
  const { baseUrl } = useAuthConfig();
  const [code, setCode] = useState(search.get('user_code') || '');
  const [checkedCode, setCheckedCode] = useState('');
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const accountReady = !!session?.user && !session.user.isAnonymous;

  useEffect(() => {
    if (!accountReady || (device && !checkedCode)) return;
    const controller = new AbortController();
    setLoading(true); setInfo(null); setError(null);
    const params = new URLSearchParams(device ? { user_code: checkedCode } : { query });
    void requestJson<RequestInfo>(`/api/oauth/request?${params}`, { signal: controller.signal }, 'Unable to read this request')
      .then(setInfo).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to read this request.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountReady, device, checkedCode, query]);

  async function decide(accept: boolean) {
    if (!info) return;
    setBusy(true); setError(null);
    try {
      const client = getAuthClient(baseUrl);
      if (device) {
        const result = accept ? await client.device.approve({ userCode: checkedCode }) : await client.device.deny({ userCode: checkedCode });
        if (result.error) throw new Error(result.error.error_description || 'Unable to complete this request.');
        setFinished(accept ? 'Device approved. Return to your device to finish connecting.' : 'Request denied. You can close this page.');
      } else {
        const result = await client.oauth2.consent({ accept, scope: info.scopes.join(' ') });
        if (result.error) throw new Error(result.error.message || 'Unable to complete this request.');
        // The auth client's redirect hook follows the provider-validated destination.
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to complete this request.'); }
    finally { setBusy(false); }
  }

  const signIn = device ? `/signin?returnTo=${encodeURIComponent(`/oauth/device?user_code=${encodeURIComponent(code)}`)}` : `/signin?${query}`;
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto flex min-h-full max-w-xl items-center px-5 py-10">
    <div className="w-full space-y-6">
      <Link href="/app" className="text-xs font-semibold tracking-widest uppercase text-accent">OpenReader</Link>
      <Surface elevation="1" className="overflow-hidden">
        <div className="border-b border-line px-6 py-6 sm:px-8">
          <p className="mb-2 text-xs uppercase tracking-widest text-soft">{device ? 'Connect a device' : 'App access'}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{info ? `${info.name} wants to connect` : device ? 'Authorize your device' : 'Connect an app'}</h1>
          {info && <div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone="muted">Unverified app</Badge><span className="break-all text-sm text-soft">{info.destination}</span></div>}
        </div>
        <div className="space-y-5 px-6 py-6 sm:px-8">
          {isPending ? <LoadingSpinner className="h-6 w-6" /> : !accountReady ? <>
            <p className="text-sm text-soft">Sign in to a personal account before connecting an app. Guest sessions cannot approve access.</p>
            <Link href={signIn} className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">Sign in</Link>
          </> : finished ? <p role="status" className="text-sm">{finished}</p> : <>
            {device && <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); setCheckedCode(code.trim()); }}>
              <Field label="Code shown on your device" className="flex-1"><Input aria-label="Code shown on your device" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" maxLength={64} disabled={busy} /></Field>
              <Button type="submit" disabled={busy || !code.trim()}>Check code</Button>
            </form>}
            {loading && <p role="status" className="text-sm text-soft">Reading connection request…</p>}
            {info && <>
              <p className="text-sm text-soft">App names are self-reported. Check the destination and approve only an app you intended to use.</p>
              {device && <p className="rounded-md border border-line bg-surface-sunken p-3 text-sm">Only approve a code displayed by a device you are using. Do not approve an unexpected code sent by someone else.</p>}
              <div><h2 className="mb-3 text-sm font-semibold">This app will be able to</h2><ul className="divide-y divide-line border-y border-line">
                {info.scopes.map(scope => <li key={scope} className="py-3 text-sm">{API_SCOPE_LABELS[scope] || scope}</li>)}
              </ul></div>
              <p className="text-xs leading-relaxed text-soft">The app shares your existing compute limits. It cannot change provider credentials or administer the instance. You can disconnect it in Settings → Account → Connected apps.</p>
              <div className="flex justify-end gap-2 pt-2"><Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>Deny</Button><Button variant="primary" disabled={busy} onClick={() => void decide(true)}>{busy ? 'Connecting…' : 'Allow access'}</Button></div>
            </>}
          </>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </Surface>
      <p className="text-center text-xs text-soft">Your provider credentials stay with this OpenReader instance.</p>
    </div>
  </div></div>;
}
