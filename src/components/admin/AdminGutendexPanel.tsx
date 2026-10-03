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
  const [serverUrl, setServerUrl] = useState(EMPTY.serverUrl);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch('/api/admin/gutendex', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Unable to load catalog settings');
      const loaded = await response.json() as GutendexSettings;
      setSettings(loaded);
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
      <div className="space-y-5 animate-pulse" aria-label="Loading catalog settings" aria-busy="true">
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

  const field = (label: string, input: ReactNode, meta?: ReactNode) => (
    <SettingRow label={label} meta={meta} controlClassName="w-[min(20rem,60%)]">
      {input}
    </SettingRow>
  );
  return (
    <div className="space-y-5">
      <Section title="Project Gutenberg" variant="group">
        <ToggleRow
          label="Enable the Project Gutenberg catalog"
          description="Adds a Project Gutenberg tab to Add Documents, where readers can search the catalog and add public domain books to their library."
          checked={settings.enabled}
          disabled={saving}
          onChange={(enabled) => void save({ enabled })}
          variant="plain"
        />
        {field(
          'Gutendex server',
          <Input aria-label="Gutendex server" type="url" value={serverUrl} placeholder="https://gutendex.com" onChange={(event) => setServerUrl(event.target.value)} />,
        )}
        {field(
          'API key (optional)',
          <Input aria-label="Gutendex API key" type="password" autoComplete="new-password" value={apiKey} placeholder={settings.apiKeyConfigured ? 'Enter to replace' : 'Only for servers that require one'} onChange={(event) => setApiKey(event.target.value)} />,
          settings.apiKeyConfigured ? `Saved key: ${settings.apiKeyMask}` : 'No key saved',
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={saving}
            onClick={() => void save({ serverUrl, ...(apiKey.trim() ? { apiKey } : {}) })}
          >
            Save configuration
          </Button>
          {settings.apiKeyConfigured && <Button variant="outline" size="sm" disabled={saving} onClick={() => void save({ apiKey: null })}>Remove saved key</Button>}
        </div>
      </Section>
      <Section title="About Gutendex" variant="group">
        <p className="text-sm text-soft">
          Search goes through a <a href="https://github.com/garethbjohnson/gutendex" target="_blank" rel="noreferrer" className="text-accent hover:underline">Gutendex</a> server.
          The public one at gutendex.com needs no key but is shared, and searching it can be slow; a self-hosted server can require an API key, which is sent as <code>X-API-Key</code> from this server only and never reaches a browser.
          Books always download from gutenberg.org.
        </p>
      </Section>
    </div>
  );
}
