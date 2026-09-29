'use client';

import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { Button, Input, Section, SettingRow, ToggleRow } from '@/components/ui';
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
  const emailField = (label: string, input: ReactNode, meta?: ReactNode) => (
    <SettingRow label={label} meta={meta} controlClassName="w-[min(20rem,60%)]">
      {input}
    </SettingRow>
  );
  return (
    <div className="space-y-5">
      <Section title="Account email delivery" variant="group">
        <ToggleRow
          label="Enable account emails"
          description="Require verified email addresses for password sign-in and enable password recovery. Existing sessions stay active."
          checked={settings.enabled}
          disabled={saving}
          onChange={(enabled) => void save({ enabled })}
          variant="plain"
        />
        {emailField('Sender name', <Input aria-label="Sender name" value={draft.senderName} onChange={(event) => setDraft({ ...draft, senderName: event.target.value })} />)}
        {emailField('Sender email', <Input aria-label="Sender email" type="email" value={draft.senderEmail} placeholder="reader@example.com" onChange={(event) => setDraft({ ...draft, senderEmail: event.target.value })} />)}
        {emailField('Reply-to (optional)', <Input aria-label="Reply-to (optional)" type="email" value={draft.replyTo ?? ''} placeholder="support@example.com" onChange={(event) => setDraft({ ...draft, replyTo: event.target.value || null })} />)}
        {emailField(
          'Resend API key',
          <Input aria-label="Resend API key" type="password" autoComplete="new-password" value={apiKey} placeholder={settings.apiKeyConfigured ? 'Enter to replace' : 're_…'} onChange={(event) => setApiKey(event.target.value)} />,
          settings.apiKeyConfigured ? `Saved key: ${settings.apiKeyMask}` : 'No key saved',
        )}
        <div className="space-y-2">
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
      <Section title="Resend setup" variant="group">
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-soft">
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
    <div className="space-y-5 animate-pulse" aria-label="Loading email settings" aria-busy="true">
      <Section title="Account email delivery" variant="group">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex items-center justify-between gap-3">
            <div className="h-4 w-32 rounded bg-offbase" />
            <div className="h-8 w-56 rounded-md bg-offbase" />
          </div>
        ))}
      </Section>
    </div>
  );
}
