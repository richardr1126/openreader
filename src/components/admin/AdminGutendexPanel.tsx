'use client';

import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { Button, Input, Section, SettingRow, ToggleRow } from '@/components/ui';

type GutendexSettings = {
  enabled: boolean;
  serverUrl: string;
  apiKeyConfigured: boolean;
  apiKeyMask: string | null;
};

const EMPTY: GutendexSettings = {
  enabled: true,
  serverUrl: 'https://gutendex.com',
  apiKeyConfigured: false,
  apiKeyMask: null,
};

export function AdminGutendexPanel() {
  const [settings, setSettings] = useState<GutendexSettings>(EMPTY);
  const [enabled, setEnabled] = useState(EMPTY.enabled);
  const [serverUrl, setServerUrl] = useState(EMPTY.serverUrl);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch('/api/admin/gutendex', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Unable to load catalog settings');
      const loaded = await response.json() as GutendexSettings;
      setSettings(loaded);
      setEnabled(loaded.enabled);
      setServerUrl(loaded.serverUrl);
    }).catch(() => toast.error('Failed to load catalog settings')).finally(() => setLoading(false));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/gutendex', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await response.json() as GutendexSettings & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to save catalog settings');
      setSettings(body);
      setEnabled(body.enabled);
      setServerUrl(body.serverUrl);
      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) setApiKey('');
      toast.success('Catalog settings saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save catalog settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse" aria-label="Loading catalog settings" aria-busy="true">
        <Section title="Project Gutenberg" variant="group">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center justify-between gap-3">
              <div className="h-4 w-32 rounded bg-offbase" />
              <div className="h-8 w-56 rounded-md bg-offbase" />
            </div>
          ))}
        </Section>
      </div>
    );
  }

  const changed = enabled !== settings.enabled || serverUrl !== settings.serverUrl || Boolean(apiKey.trim());
  const field = (label: string, input: ReactNode, meta?: ReactNode) => (
    <SettingRow label={label} meta={meta} controlClassName="w-[min(20rem,60%)]">
      {input}
    </SettingRow>
  );
  return (
    <Section title="Project Gutenberg" variant="group">
        <ToggleRow
          label="Enable the Project Gutenberg catalog"
          description="Adds a Project Gutenberg tab to Add Documents, where readers can search the catalog and add public domain books to their library."
          checked={enabled}
          disabled={saving}
          onChange={setEnabled}
          variant="plain"
        />
        {field(
          'Gutendex server',
          <Input disabled={saving} aria-label="Gutendex server" type="url" value={serverUrl} placeholder="https://gutendex.com" onChange={(event) => setServerUrl(event.target.value)} />,
        )}
        {field(
          'API key (optional)',
          <Input disabled={saving} aria-label="Gutendex API key" type="password" autoComplete="new-password" value={apiKey} placeholder={settings.apiKeyConfigured ? 'Enter to replace' : 'Only for servers that require one'} onChange={(event) => setApiKey(event.target.value)} />,
          settings.apiKeyConfigured ? `Saved key: ${settings.apiKeyMask}` : 'No key saved',
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !changed}
            onClick={() => void save({ enabled, serverUrl, ...(apiKey.trim() ? { apiKey } : {}) })}
          >
            Save
          </Button>
          {settings.apiKeyConfigured && <Button variant="outline" size="sm" disabled={saving} onClick={() => void save({ apiKey: null })}>Remove saved key</Button>}
        </div>
        <p className="text-xs text-soft">
          Search goes through a <a href="https://github.com/garethbjohnson/gutendex" target="_blank" rel="noreferrer" className="text-accent hover:underline">Gutendex</a> server.
          The public one at gutendex.com needs no key but is shared, and searching it can be slow; a self-hosted server can require an API key, which is sent as <code>X-API-Key</code> from this server only and never reaches a browser.
          Books always download from gutenberg.org.
        </p>
      </Section>
  );
}
