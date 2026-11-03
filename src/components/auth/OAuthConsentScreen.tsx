'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, ButtonLink, Field, InlineButton, Input } from '@/components/ui';
import { AuthCard } from '@/components/auth/AuthCard';
import { CheckIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAuthClient } from '@/lib/client/auth-client';
import { requestJson } from '@/lib/client/api/http';
import { API_SCOPE_LABELS } from '@/lib/shared/api-scopes';

type RequestInfo = { name: string; scopes: string[]; destination: string | null; clientId: string; verifiedDomain: string | null };
export function OAuthConsentScreen({ device = false }: { device?: boolean }) {
  const search = useSearchParams();
  const query = search.toString();
  const router = useRouter();
  const { data: session, isPending } = useAuthSession();
  const { baseUrl } = useAuthConfig();
  const { installProfile } = useRuntimeConfig();
  const linkedCode = search.get('user_code')?.trim() || '';
  const [code, setCode] = useState(linkedCode);
  const [checkedCode, setCheckedCode] = useState(linkedCode);
  const [attempt, setAttempt] = useState(0);
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null);
  const [finished, setFinished] = useState<{ title: string; detail: string } | null>(null);
  const accountReady = !!session?.user && !session.user.isAnonymous;
  const busy = decision !== null;

  useEffect(() => {
    if (!accountReady || (device && !checkedCode)) return;
    const controller = new AbortController();
    setLoading(true); setInfo(null); setError(null);
    const params = new URLSearchParams(device ? { user_code: checkedCode } : { query });
    void requestJson<RequestInfo>(`/api/oauth/request?${params}`, { signal: controller.signal }, 'Unable to read this request')
      .then(setInfo).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to read this request.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountReady, device, checkedCode, attempt, query]);

  async function decide(accept: boolean) {
    if (!info) return;
    setDecision(accept ? 'allow' : 'deny'); setError(null);
    try {
      const client = getAuthClient(baseUrl);
      if (device) {
        const result = accept ? await client.device.approve({ userCode: checkedCode }) : await client.device.deny({ userCode: checkedCode });
        if (result.error) throw new Error(result.error.error_description || 'Unable to complete this request.');
        setFinished(accept
          ? { title: 'Device connected', detail: 'Device approved. Return to your device to finish connecting.' }
          : { title: 'Request denied', detail: 'You can close this page.' });
      } else {
        const result = await client.oauth2.consent({ accept, scope: info.scopes.join(' ') });
        if (result.error) throw new Error(result.error.message || 'Unable to complete this request.');
        // The auth client's redirect hook follows the provider-validated destination.
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to complete this request.'); }
    finally { setDecision(null); }
  }

  function clearCode() {
    setInfo(null); setError(null); setCode(''); setCheckedCode('');
  }

  const signIn = device ? `/signin?returnTo=${encodeURIComponent(`/oauth/device?user_code=${encodeURIComponent(code)}`)}` : `/signin?${query}`;

  async function switchAccount() {
    setError(null);
    const { error } = await getAuthClient(baseUrl).signOut();
    if (error) setError(error.message || 'Unable to sign out.');
    else router.push(signIn);
  }

  const failed = !device && !info && !loading && !!error;
  const title = !isPending && !accountReady ? 'Sign in to connect'
    : finished ? finished.title
    : info ? `${info.name} wants to connect`
    : failed ? 'This request can’t continue'
    : device ? 'Connect a device' : 'Connect an app';
  const warning = !info ? null
    : device ? 'Only allow a code shown by a device you are using, never one someone sent you.'
    : info.verifiedDomain ? null
    : 'OpenReader can’t confirm who made this app. Allow it only if you just started connecting it.';
  const returnsElsewhere = info?.destination && info.destination !== info.verifiedDomain;

  return <AuthCard title={title} description={info && !finished && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    {info.verifiedDomain
      ? <span className="inline-flex items-center gap-1 text-foreground"><CheckIcon className="h-4 w-4 text-accent" />Verified as {info.verifiedDomain}</span>
      : <Badge tone="foreground">Unverified app</Badge>}
    {returnsElsewhere && <span>Returns to <span className="break-words font-medium text-foreground">{info.destination}</span></span>}
  </div>}>
        {isPending ? <LoadingSpinner className="mx-auto h-6 w-6 text-soft" /> : !accountReady ? <>
          <p className="text-sm text-soft">Guest sessions can’t approve access.</p>
          <ButtonLink href={signIn} variant="primary" className="w-full">Sign in</ButtonLink>
        </> : finished ? <p role="status" className="text-sm text-soft">{finished.detail}</p> : <>
          {device && !info && <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); setCheckedCode(code.trim()); setAttempt(count => count + 1); }}>
            <Field label="Code shown on your device" className="flex-1"><Input aria-label="Code shown on your device" className="font-mono" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" autoFocus={!linkedCode} maxLength={64} disabled={loading} /></Field>
            <Button type="submit" variant="primary" disabled={loading || !code.trim()}>Check code</Button>
          </form>}
          {loading && <div role="status" aria-label="Reading connection request" className="flex justify-center py-2"><LoadingSpinner className="h-6 w-6 text-soft" /></div>}
          {info && <>
            {device && <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm">
              <span className="min-w-0"><span className="text-soft">Code </span><span className="break-words font-mono font-medium text-foreground">{checkedCode}</span></span>
              <InlineButton className="shrink-0 whitespace-nowrap" disabled={busy} onClick={clearCode}>Use a different code</InlineButton>
            </div>}
            {warning && <p className="text-sm text-soft">{warning}</p>}
            <div>
              <h2 className="mb-2 text-sm font-semibold text-foreground">This app will be able to</h2>
              <ul className="space-y-2">
                {info.scopes.map(scope => <li key={scope} className="flex gap-2 text-sm text-foreground"><CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-soft" /><span>{API_SCOPE_LABELS[scope] || scope}</span></li>)}
              </ul>
            </div>
            <p className="text-xs leading-relaxed text-soft">It can’t see your provider keys or administer this instance. Disconnect it anytime in Settings → Account → Connected apps.</p>
            {installProfile !== 'desktop' && session?.user.name && <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-sm">
              <span className="min-w-0 text-soft">Signed in as <span className="break-words font-medium text-foreground">{session.user.name}</span></span>
              <InlineButton className="shrink-0 whitespace-nowrap" disabled={busy} onClick={() => void switchAccount()}>Switch account</InlineButton>
            </div>}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
              <Button variant="primary" disabled={busy} onClick={() => void decide(true)}>{decision === 'allow' ? 'Connecting…' : 'Allow access'}</Button>
            </div>
          </>}
        </>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </AuthCard>;
}
