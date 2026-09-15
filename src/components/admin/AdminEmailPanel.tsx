'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Field, Input, Section, ToggleRow } from '@/components/ui';
import {
  buildEmailSettingsPatch,
  emailSettingsDraftFromResponse,
  type EmailSettings,
  type EmailSettingsDraft,
} from './email-settings-form';

const EMPTY: EmailSettings = {
  enabled: false,
  senderName: 'OpenReader',
  senderEmail: '',
  replyTo: null,
  apiKeyConfigured: false,
  apiKeyMask: null,
};

export function AdminEmailPanel() {
  const [settings, setSettings] = useState<EmailSettings>(EMPTY);
  const [draft, setDraft] = useState<EmailSettingsDraft>(EMPTY);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'queued' | 'accepted' | 'failed'>('idle');

  useEffect(() => {
    void fetch('/api/admin/email', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Unable to load email settings');
      const loaded = await response.json() as EmailSettings;
      setSettings(loaded);
      setDraft(emailSettingsDraftFromResponse(loaded));
    }).catch(() => toast.error('Failed to load email settings')).finally(() => setLoading(false));
  }, []);

  const save = async (patch: Record<string, unknown>, syncDraft = false) => {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/email', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await response.json() as EmailSettings & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to save email settings');
      setSettings(body);
      if (syncDraft) setDraft(emailSettingsDraftFromResponse(body));
      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) setApiKey('');
      toast.success('Email settings saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save email settings');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTestState('queued');
    try {
      const response = await fetch('/api/admin/email/test', { method: 'POST' });
      const body = await response.json() as { operation?: { opId: string; status: string; result?: { status?: string } }; error?: string };
      if (!response.ok || !body.operation) {
        throw new Error(body.error || 'Unable to queue test email');
      }
      if (body.operation.status === 'succeeded') {
        setTestState('accepted');
        return;
      }
      const source = new EventSource(`/api/admin/email/test/events?opId=${encodeURIComponent(body.operation.opId)}`);
      source.addEventListener('snapshot', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { snapshot?: { status?: string } };
          if (payload.snapshot?.status === 'succeeded') {
            setTestState('accepted');
            source.close();
          } else if (payload.snapshot?.status === 'failed') {
            setTestState('failed');
            source.close();
          }
        } catch {
          setTestState('failed');
          source.close();
          toast.error('Unable to read test email status');
        }
      });
      source.onerror = () => { setTestState('failed'); source.close(); };
    } catch (error) {
      setTestState('failed');
      toast.error(error instanceof Error ? error.message : 'Unable to queue test email');
    }
  };

  if (loading) return <EmailSettingsSkeleton />;
  return (
    <div className="space-y-4">
      <Section
        title="Account email delivery"
        subtitle="Verification and password recovery use Resend through the durable compute queue."
        action={<Badge tone={settings.enabled ? 'accent' : 'muted'}>{settings.enabled ? 'Enabled' : 'Off by default'}</Badge>}
      >
        <div className="space-y-4">
          <ToggleRow
            label="Enable account emails"
            description="Require verified email addresses for password sign-in and enable password recovery. Existing sessions stay active."
            checked={settings.enabled}
            disabled={saving}
            onChange={(enabled) => void save({ enabled })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sender name"><Input aria-label="Sender name" value={draft.senderName} onChange={(event) => setDraft({ ...draft, senderName: event.target.value })} /></Field>
            <Field label="Sender email"><Input aria-label="Sender email" type="email" value={draft.senderEmail} placeholder="reader@example.com" onChange={(event) => setDraft({ ...draft, senderEmail: event.target.value })} /></Field>
            <Field label="Reply-to (optional)"><Input aria-label="Reply-to (optional)" type="email" value={draft.replyTo ?? ''} placeholder="support@example.com" onChange={(event) => setDraft({ ...draft, replyTo: event.target.value || null })} /></Field>
            <Field label="Resend API key" hint={settings.apiKeyConfigured ? `Saved key: ${settings.apiKeyMask}` : 'No key saved'}>
              <Input aria-label="Resend API key" type="password" autoComplete="new-password" value={apiKey} placeholder={settings.apiKeyConfigured ? 'Enter to replace' : 're_…'} onChange={(event) => setApiKey(event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save(buildEmailSettingsPatch(draft, apiKey), true)}>Save configuration</Button>
            {settings.apiKeyConfigured && <Button variant="outline" size="sm" disabled={saving} onClick={() => void save({ apiKey: null })}>Remove saved key</Button>}
            <Button variant="outline" size="sm" disabled={saving || !settings.apiKeyConfigured || !settings.senderEmail || testState === 'queued'} onClick={sendTest}>Send test email</Button>
          </div>
          {testState !== 'idle' && (
            <p className={`text-xs ${testState === 'failed' ? 'text-danger' : 'text-soft'}`}>
              {testState === 'queued' ? 'Test queued for delivery…' : testState === 'accepted' ? 'Accepted by Resend. Inbox delivery is not yet confirmed.' : 'Test delivery failed. Check the saved key and verified sender domain.'}
            </p>
          )}
        </div>
      </Section>
      <Section title="Resend setup" subtitle="Domain ownership and API key permissions are managed in Resend.">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-soft">
          <li>Verify the sender domain in Resend.</li>
          <li>Create a sending-only API key, preferably restricted to that domain.</li>
          <li>Save the key and sender above, then send a test before enabling account emails.</li>
        </ol>
      </Section>
    </div>
  );
}

function EmailSettingsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-label="Loading email settings" aria-busy="true">
      <Section
        title="Account email delivery"
        subtitle="Verification and password recovery use Resend through the durable compute queue."
        action={<div className="h-4 w-20 rounded bg-offbase" />}
      >
        <div className="rounded-md border border-line px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-4 w-40 rounded bg-offbase" />
              <div className="h-3 w-72 max-w-full rounded bg-offbase" />
            </div>
            <div className="h-5 w-9 shrink-0 rounded-pill bg-offbase" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="space-y-1">
              <div className="h-3 w-24 rounded bg-offbase" />
              <div className="h-9 w-full rounded-md bg-offbase" />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="h-8 w-32 rounded-md bg-offbase" />
          <div className="h-8 w-28 rounded-md bg-offbase" />
          <div className="h-8 w-28 rounded-md bg-offbase" />
        </div>
      </Section>

      <Section
        title="Resend setup"
        subtitle="Domain ownership and API key permissions are managed in Resend."
      >
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-4 w-4/5 max-w-md rounded bg-offbase" />
          ))}
        </div>
      </Section>
    </div>
  );
}
