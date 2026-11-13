'use client';

import {
  AudioWaveIcon, ClockIcon, CubeIcon, DatabaseIcon, HourglassIcon, MicrophoneIcon, RefreshIcon,
} from '@/components/icons/Icons';
import { Section, Select, SelectOptionDetail, SettingRow } from '@/components/ui';
import { AdminSettingsSkeleton, useAdminSettingsDraft } from './admin-settings-draft';

type PlaybackBackgroundExtent = 'section' | 'document';

const BACKGROUND_EXTENT_OPTIONS: Array<{ value: PlaybackBackgroundExtent; label: string; description: string }> = [
  {
    value: 'section',
    label: 'Current section',
    description: 'Continue through the current PDF page or EPUB chapter after the client stops heartbeating.',
  },
  {
    value: 'document',
    label: 'Full document',
    description: 'Continue generating from the current position through the rest of the document.',
  },
];

/** Below the provider list: what readers may choose, and how the worker calls providers. */
export function AdminGenerationPanel() {
  const { loaded, draft, update, source, toggle, number, saveBar } = useAdminSettingsDraft('Generation settings saved');

  if (!loaded) return <AdminSettingsSkeleton titles={['Reader choices', 'Generation']} label="Loading generation settings" />;

  const extent = BACKGROUND_EXTENT_OPTIONS.find((option) => option.value === draft.ttsPlaybackBackgroundExtent)
    ?? BACKGROUND_EXTENT_OPTIONS[0];

  return (
    <div className="space-y-5">
      <Section title="Reader choices" variant="group" footer="New users start with the default provider, set from its menu above.">
        {toggle({
          key: 'enableTtsProvidersTab',
          label: 'Show Model & Voice settings',
          icon: <MicrophoneIcon />,
          info: 'Let users choose their own provider, model and voice.',
        })}
        {toggle({
          key: 'showAllProviderModels',
          label: 'Show all provider models',
          icon: <CubeIcon />,
          info: 'Offer every model a provider reports, not only the recommended ones.',
        })}
      </Section>

      <Section title="Generation" variant="group">
        <SettingRow
          label="Background generation"
          icon={<AudioWaveIcon />}
          info="How far the worker keeps generating after the reader stops sending its position."
          meta={source('ttsPlaybackBackgroundExtent')}
          controlClassName="w-52"
        >
          <Select
            aria-label="Background generation"
            value={extent}
            onChange={(option) => update('ttsPlaybackBackgroundExtent', option.value)}
            options={BACKGROUND_EXTENT_OPTIONS}
            getOptionKey={(option) => option.value}
            renderValue={(option) => option.label}
            renderOption={(option, { selected }) => (
              <span className="block">
                <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>{option.label}</span>
                <SelectOptionDetail>{option.description}</SelectOptionDetail>
              </span>
            )}
            chevronClassName="h-4 w-4 text-muted"
          />
        </SettingRow>
        {number({ key: 'ttsUpstreamMaxRetries', label: 'Retry attempts', icon: <RefreshIcon />, info: 'Times a failed provider request is retried before the segment fails.' })}
        {number({ key: 'ttsUpstreamTimeoutMs', label: 'Upstream timeout', icon: <ClockIcon />, unit: 'ms' })}
      </Section>

      <Section title="Worker audio cache" variant="group">
        {number({ key: 'ttsCacheMaxSizeBytes', label: 'Audio cache size', icon: <DatabaseIcon />, info: 'In-memory cache of recently generated audio on the worker.', unit: 'bytes' })}
        {number({ key: 'ttsCacheTtlMs', label: 'Audio cache TTL', icon: <HourglassIcon />, unit: 'ms' })}
      </Section>

      {saveBar}
    </div>
  );
}
