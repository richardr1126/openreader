'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { DocumentIcon, HeadphonesIcon, KeyIcon, RefreshIcon, RssIcon, UploadIcon } from '@/components/icons/Icons';
import { Input, Section, SettingRow, ToggleRow } from '@/components/ui';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useDesktopUpdates } from '@/hooks/useDesktopUpdates';
import { AdminGutendexPanel } from './AdminGutendexPanel';
import { AdminSettingsSkeleton, useAdminSettingsDraft } from './admin-settings-draft';

/** What the app offers readers: documents, the Gutenberg catalog, exports and connected apps. */
export function AdminFeaturesPanel() {
  // The changelog feed is for hosted instances; desktop reads the bundled one.
  const multiUser = useRuntimeConfig().installProfile === 'server';
  const { loaded, draft, update, source, toggle, number, saveBar } = useAdminSettingsDraft('Feature settings saved');

  // Desktop updates save on this computer, so they stay usable while site settings load or fail.
  if (!loaded) return (
    <div className="space-y-5">
      <AdminSettingsSkeleton titles={['Documents', 'Connected apps']} label="Loading feature settings" />
      <DesktopUpdatesSection />
    </div>
  );

  return (
    <div className="space-y-5">
      <Section title="Documents" variant="group">
        {number({ key: 'maxUploadMb', label: 'Max upload size', icon: <UploadIcon />, ariaLabel: 'Max upload size in megabytes', unit: 'MB' })}
        {toggle({
          key: 'enableDocxConversion',
          label: 'DOCX upload conversion',
          icon: <DocumentIcon />,
          info: 'Allows DOCX uploads, converted to PDF on the worker.',
        })}
        {toggle({
          key: 'enableAudiobookExport',
          label: 'Audiobook export',
          icon: <HeadphonesIcon />,
          info: 'Shows Export audiobook on PDF and EPUB pages.',
        })}
      </Section>

      {/* Saves on its own: the catalog key is write-only. */}
      <AdminGutendexPanel />

      <Section title="Connected apps" variant="group">
        {toggle({
          key: 'allowOAuthClientRegistration',
          label: 'Open OAuth client registration',
          icon: <KeyIcon />,
          info: 'Let new third-party apps connect, by registering or with a client ID metadata document. This does not grant access; each account must approve its scopes.',
        })}
      </Section>

      {multiUser ? (
        <Section title="Changelog" variant="group">
          <SettingRow
            label="Changelog feed URL"
            icon={<RssIcon />}
            info="Public URL the standalone changelog page reads."
            meta={source('changelogFeedUrl')}
            stacked
          >
            <Input
              type="text"
              aria-label="Changelog feed URL"
              value={String(draft.changelogFeedUrl ?? '')}
              onChange={(event) => update('changelogFeedUrl', event.target.value)}
              placeholder="https://docs.openreader.richardr.dev/changelog/manifest.json"
            />
          </SettingRow>
        </Section>
      ) : null}

      <DesktopUpdatesSection />

      {saveBar}
    </div>
  );
}

/** Shell preferences live on this computer, not in instance settings, so they apply at once. */
function DesktopUpdatesSection() {
  const desktopUpdates = useDesktopUpdates();
  const [saving, setSaving] = useState(false);
  if (!desktopUpdates) return null;
  return (
    <Section title="Desktop app" variant="group" footer="Saved on this computer.">
      <ToggleRow
        label="Automatic updates"
        icon={<RefreshIcon />}
        info="Checks GitHub for new versions and downloads them in the background."
        checked={desktopUpdates.automatic}
        disabled={saving}
        onChange={(automatic) => {
          setSaving(true);
          desktopUpdates.setAutomatic(automatic)
            .catch((error: unknown) => {
              console.error(error);
              toast.error('Save failed');
            })
            .finally(() => setSaving(false));
        }}
        variant="plain"
      />
    </Section>
  );
}
