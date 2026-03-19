'use client';

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
  Button,
  Input,
} from '@headlessui/react';
import Link from 'next/link';
import { useTheme } from '@/contexts/ThemeContext';
import { useConfig } from '@/contexts/ConfigContext';
import { ChevronUpDownIcon, CheckIcon, SettingsIcon, KeyIcon, PaletteIcon, DocumentIcon, UserIcon, DownloadIcon } from '@/components/icons/Icons';
import { getAppConfig, getFirstVisit, setFirstVisit } from '@/lib/client/dexie';
import { useDocuments } from '@/contexts/DocumentContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProgressPopup } from '@/components/ProgressPopup';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { THEMES } from '@/contexts/ThemeContext';
import { DocumentSelectionModal } from '@/components/documents/DocumentSelectionModal';
import { BaseDocument } from '@/types/documents';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRouter } from 'next/navigation';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { deleteDocuments, mimeTypeForDoc, uploadDocuments } from '@/lib/client/api/documents';
import { cacheStoredDocumentFromBytes, clearDocumentCache } from '@/lib/client/cache/documents';
import { clearAllDocumentPreviewCaches, clearInMemoryDocumentPreviewCache } from '@/lib/client/cache/previews';

const enableDestructiveDelete = process.env.NEXT_PUBLIC_ENABLE_DESTRUCTIVE_DELETE_ACTIONS !== 'false';
const showAllDeepInfra = process.env.NEXT_PUBLIC_SHOW_ALL_DEEPINFRA_MODELS !== 'false';
const enableTTSProvidersTab = process.env.NEXT_PUBLIC_ENABLE_TTS_PROVIDERS_TAB !== 'false';

// Hard-coded theme color palettes for the visual theme selector
type ThemeColorSet = { background: string; base: string; offbase: string; accent: string; secondaryAccent: string; foreground: string; muted: string };

const THEME_COLORS: Record<string, ThemeColorSet> = {
  light: { background: '#ffffff', base: '#f7fafc', offbase: '#e2e8f0', accent: '#ef4444', secondaryAccent: '#ed6868', foreground: '#2d3748', muted: '#718096' },
  dark: { background: '#111111', base: '#171717', offbase: '#343434', accent: '#f87171', secondaryAccent: '#eb6262', foreground: '#ededed', muted: '#a3a3a3' },
  ocean: { background: '#020617', base: '#0f172a', offbase: '#1e293b', accent: '#38bdf8', secondaryAccent: '#22d3ee', foreground: '#e2e8f0', muted: '#94a3b8' },
  forest: { background: '#0a0f0c', base: '#111a15', offbase: '#1a2820', accent: '#4ade80', secondaryAccent: '#22c55e', foreground: '#d4e8d0', muted: '#7c8f85' },
  sunset: { background: '#1a0f0f', base: '#2c1810', offbase: '#3d1f14', accent: '#ff6b6b', secondaryAccent: '#f59e0b', foreground: '#ffe4d6', muted: '#bc8f8f' },
  sea: { background: '#0c1922', base: '#102c3d', offbase: '#1a3c52', accent: '#06b6d4', secondaryAccent: '#0ea5e9', foreground: '#e0f2fe', muted: '#7ca7c4' },
  mint: { background: '#0f1916', base: '#132d27', offbase: '#1c3d35', accent: '#2dd4bf', secondaryAccent: '#10b981', foreground: '#dcfce7', muted: '#75a99c' },
  lavender: { background: '#faf8ff', base: '#f3effb', offbase: '#e4daf0', accent: '#7c3aed', secondaryAccent: '#a78bfa', foreground: '#3b2e5a', muted: '#8e7bab' },
  rose: { background: '#fff8f8', base: '#fef1f1', offbase: '#f5dada', accent: '#e11d48', secondaryAccent: '#f472b6', foreground: '#4a2c2c', muted: '#b08a8a' },
  sand: { background: '#fdfbf7', base: '#f7f2e8', offbase: '#e8dfc9', accent: '#b45309', secondaryAccent: '#d97706', foreground: '#44392a', muted: '#9a8b74' },
  sky: { background: '#f6faff', base: '#edf4fc', offbase: '#d5e3f5', accent: '#2563eb', secondaryAccent: '#3b82f6', foreground: '#1e3a5f', muted: '#6b8db5' },
  slate: { background: '#e8ecf0', base: '#dde2e8', offbase: '#c8ced6', accent: '#5b7a9d', secondaryAccent: '#7393b0', foreground: '#2c3440', muted: '#7a8694' },
};

const LIGHT_THEME_IDS = new Set(['light', 'lavender', 'rose', 'sand', 'sky', 'slate']);

const allThemes = THEMES.map(id => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
}));

const systemTheme = allThemes.find(t => t.id === 'system')!;
const lightThemes = allThemes.filter(t => LIGHT_THEME_IDS.has(t.id));
const darkThemes = allThemes.filter(t => t.id !== 'system' && !LIGHT_THEME_IDS.has(t.id));

type SectionId = 'api' | 'theme' | 'docs' | 'account';

const SIDEBAR_SECTIONS: { id: SectionId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; authOnly?: boolean }[] = [
  { id: 'api', label: 'TTS Provider', icon: KeyIcon },
  { id: 'theme', label: 'Appearance', icon: PaletteIcon },
  { id: 'docs', label: 'Documents', icon: DocumentIcon },
  { id: 'account', label: 'Account', icon: UserIcon, authOnly: true },
];

export function SettingsModal({ className = '' }: { className?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>(enableTTSProvidersTab ? 'api' : 'theme');

  const { theme, setTheme } = useTheme();
  const { apiKey, baseUrl, ttsProvider, ttsModel, ttsInstructions, updateConfig, updateConfigKey } = useConfig();
  const { refreshDocuments } = useDocuments();
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl);
  const [localTTSProvider, setLocalTTSProvider] = useState(ttsProvider);
  const [modelValue, setModelValue] = useState(ttsModel);
  const [customModelInput, setCustomModelInput] = useState('');
  const [localTTSInstructions, setLocalTTSInstructions] = useState(ttsInstructions);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [selectionModalProps, setSelectionModalProps] = useState<{
    title: string;
    confirmLabel: string;
    defaultSelected: boolean;
    initialFiles?: BaseDocument[];
    fetcher?: () => Promise<BaseDocument[]>;
  }>({
    title: '',
    confirmLabel: '',
    defaultSelected: false
  });

  const [showProgress, setShowProgress] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [showDeleteDocsConfirm, setShowDeleteDocsConfirm] = useState(false);
  const [showDeleteAccountConfirm, setShowDeleteAccountConfirm] = useState(false);
  const { progress, setProgress, estimatedTimeRemaining } = useTimeEstimation();
  const { authEnabled, baseUrl: authBaseUrl } = useAuthConfig();
  const { data: session } = useAuthSession();
  const router = useRouter();
  const isBusy = isImportingLibrary;

  const ttsProviders = useMemo(() => [
    { id: 'custom-openai', name: 'Custom OpenAI-Like' },
    { id: 'deepinfra', name: 'Deepinfra' },
    { id: 'openai', name: 'OpenAI' }
  ], []);

  const ttsModels = useMemo(() => {
    switch (localTTSProvider) {
      case 'openai':
        return [
          { id: 'tts-1', name: 'TTS-1' },
          { id: 'tts-1-hd', name: 'TTS-1 HD' },
          { id: 'gpt-4o-mini-tts', name: 'GPT-4o Mini TTS' }
        ];
      case 'custom-openai':
        return [
          { id: 'kokoro', name: 'Kokoro' },
          { id: 'kitten-tts', name: 'KittenTTS' },
          { id: 'orpheus', name: 'Orpheus' },
          { id: 'custom', name: 'Other' }
        ];
      case 'deepinfra':
        if (!showAllDeepInfra && !localApiKey) {
          return [
            { id: 'hexgrad/Kokoro-82M', name: 'hexgrad/Kokoro-82M' }
          ];
        }
        return [
          { id: 'hexgrad/Kokoro-82M', name: 'hexgrad/Kokoro-82M' },
          { id: 'canopylabs/orpheus-3b-0.1-ft', name: 'canopylabs/orpheus-3b-0.1-ft' },
          { id: 'sesame/csm-1b', name: 'sesame/csm-1b' },
          { id: 'ResembleAI/chatterbox', name: 'ResembleAI/chatterbox' },
          { id: 'Zyphra/Zonos-v0.1-hybrid', name: 'Zyphra/Zonos-v0.1-hybrid' },
          { id: 'Zyphra/Zonos-v0.1-transformer', name: 'Zyphra/Zonos-v0.1-transformer' },
          { id: 'custom', name: 'Other' }
        ];
      default:
        return [
          { id: 'tts-1', name: 'TTS-1' }
        ];
    }
  }, [localTTSProvider, localApiKey]);

  const supportsCustom = useMemo(() => localTTSProvider !== 'openai', [localTTSProvider]);

  const selectedModelId = useMemo(
    () => {
      const isPreset = ttsModels.some(m => m.id === modelValue);
      if (isPreset) return modelValue;
      return supportsCustom ? 'custom' : (ttsModels[0]?.id ?? '');
    },
    [ttsModels, modelValue, supportsCustom]
  );

  const canSubmit = useMemo(
    () => selectedModelId !== 'custom' || (supportsCustom && customModelInput.trim().length > 0),
    [selectedModelId, supportsCustom, customModelInput]
  );

  const checkFirstVist = useCallback(async () => {
    const appConfig = await getAppConfig();
    if (authEnabled && !appConfig?.privacyAccepted) {
      return;
    }
    const firstVisit = await getFirstVisit();
    if (!firstVisit) {
      await setFirstVisit(true);
      setIsOpen(true);
    }
  }, [authEnabled, setIsOpen]);

  useEffect(() => {
    checkFirstVist().catch((err) => {
      console.error('First visit check failed:', err);
    });
    setLocalApiKey(apiKey);
    setLocalBaseUrl(baseUrl);
    setLocalTTSProvider(ttsProvider);
    setModelValue(ttsModel);
    setLocalTTSInstructions(ttsInstructions);
  }, [apiKey, baseUrl, ttsProvider, ttsModel, ttsInstructions, checkFirstVist]);

  useEffect(() => {
    if (!authEnabled) {
      return;
    }
    const onPrivacyAccepted = () => {
      checkFirstVist().catch((err) => {
        console.error('First visit check after privacy acceptance failed:', err);
      });
    };
    window.addEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    return () => {
      window.removeEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    };
  }, [authEnabled, checkFirstVist]);

  useEffect(() => {
    if (!ttsModels.some(m => m.id === modelValue) && modelValue !== '') {
      setCustomModelInput(modelValue);
    } else {
      setCustomModelInput('');
    }
  }, [modelValue, ttsModels]);

  const handleRefresh = async () => {
    try {
      clearInMemoryDocumentPreviewCache();
      await refreshDocuments();
    } catch (error) {
      console.error('Failed to refresh documents:', error);
    }
  };

  const handleClearCache = async () => {
    try {
      await Promise.all([
        clearDocumentCache(),
        clearAllDocumentPreviewCaches(),
      ]);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  };

  const handleImportLibrary = async () => {
    setSelectionModalProps({
      title: 'Import from Library',
      confirmLabel: 'Import',
      defaultSelected: false,
      fetcher: async () => {
        const res = await fetch('/api/documents/library?limit=10000');
        if (!res.ok) throw new Error('Failed to list library documents');
        const data = await res.json();
        return data.documents || [];
      }
    });
    setIsSelectionModalOpen(true);
  };

  const handleModalConfirm = async (selectedFiles: BaseDocument[]) => {
    const controller = new AbortController();
    setAbortController(controller);
    setIsSelectionModalOpen(false);

    try {
      setShowProgress(true);
      setProgress(0);
      setIsImportingLibrary(true);

      for (let i = 0; i < selectedFiles.length; i++) {
        if (controller.signal.aborted) break;
        const doc = selectedFiles[i];
        setStatusMessage(`Importing ${i + 1}/${selectedFiles.length}: ${doc.name}`);
        setProgress((i / Math.max(1, selectedFiles.length)) * 90);

        const contentResponse = await fetch(`/api/documents/library/content?id=${encodeURIComponent(doc.id)}`, {
          signal: controller.signal,
        });
        if (!contentResponse.ok) {
          console.warn(`Failed to download library document: ${doc.name}`);
          continue;
        }

        const bytes = await contentResponse.arrayBuffer();
        const file = new File([bytes], doc.name, {
          type: mimeTypeForDoc(doc),
          lastModified: doc.lastModified,
        });

        const uploaded = await uploadDocuments([file], { signal: controller.signal });
        const stored = uploaded[0];
        if (stored) {
          await cacheStoredDocumentFromBytes(stored, bytes).catch((err) => {
            console.warn('Failed to cache imported document:', stored.id, err);
          });
        }
      }

      if (!controller.signal.aborted) {
        setProgress(95);
        await refreshDocuments();
        setProgress(100);
        setStatusMessage('Import complete');
      }

    } catch (error) {
      if (controller.signal.aborted) {
        console.log('library import cancelled');
        setStatusMessage('Operation cancelled');
      } else {
        console.error('library import failed:', error);
        setStatusMessage('Import failed. Please try again.');
      }
    } finally {
      setIsImportingLibrary(false);
      setShowProgress(false);
      setProgress(0);
      setStatusMessage('');
      setAbortController(null);
    }
  };

  const handleDeleteDocs = async () => {
    try {
      await deleteDocuments();
      await refreshDocuments().catch(() => { });
    } catch (error) {
      console.error('Delete failed:', error);
    } finally {
      setShowDeleteDocsConfirm(false);
    }
  };

  const handleSignOut = async () => {
    const client = getAuthClient(authBaseUrl);
    await client.signOut();
    router.push('/signin');
  };

  const handleDeleteAccount = async () => {
    try {
      const res = await fetch('/api/account/delete', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete account');

      const client = getAuthClient(authBaseUrl);
      await client.signOut();
      window.location.href = '/signup';
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
    setShowDeleteAccountConfirm(false);
  };

  const handleInputChange = (type: 'apiKey' | 'baseUrl', value: string) => {
    if (type === 'apiKey') {
      setLocalApiKey(value === '' ? '' : value);
    } else if (type === 'baseUrl') {
      setLocalBaseUrl(value === '' ? '' : value);
    }
  };

  const resetToCurrent = useCallback(() => {
    setIsOpen(false);
    setLocalApiKey(apiKey);
    setLocalBaseUrl(baseUrl);
    setLocalTTSProvider(ttsProvider);
    setModelValue(ttsModel);
    setLocalTTSInstructions(ttsInstructions);
    if (!ttsModels.some(m => m.id === ttsModel) && ttsModel !== '') {
      setCustomModelInput(ttsModel);
    } else {
      setCustomModelInput('');
    }
  }, [apiKey, baseUrl, ttsProvider, ttsModel, ttsInstructions, ttsModels]);

  const [systemIsDark, setSystemIsDark] = useState(
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const getThemeColors = useCallback((id: string): ThemeColorSet => {
    if (id === 'system') return THEME_COLORS[systemIsDark ? 'dark' : 'light'];
    return THEME_COLORS[id] || THEME_COLORS.light;
  }, [systemIsDark]);

  const visibleSections = useMemo(
    () => SIDEBAR_SECTIONS.filter((section) => {
      if (section.id === 'api' && !enableTTSProvidersTab) {
        return false;
      }
      return !section.authOnly || authEnabled;
    }),
    [authEnabled]
  );

  useEffect(() => {
    if (visibleSections.some(section => section.id === activeSection)) {
      return;
    }
    setActiveSection(visibleSections[0]?.id ?? 'theme');
  }, [activeSection, visibleSections]);

  const btnBase = "inline-flex items-center justify-center rounded-lg text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transform transition-transform duration-200 ease-in-out";
  const btnPrimary = `${btnBase} bg-accent text-background hover:bg-secondary-accent hover:scale-[1.04]`;
  const btnSecondary = `${btnBase} bg-background text-foreground hover:bg-offbase hover:text-accent hover:scale-[1.04]`;
  const btnOutline = `${btnBase} bg-background border border-offbase text-foreground hover:bg-offbase hover:text-accent hover:scale-[1.02]`;

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className={`inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.09] hover:text-accent ${className}`}
        aria-label="Settings"
        tabIndex={0}
      >
        <SettingsIcon className="w-4 h-4 transform transition-transform duration-200 ease-in-out hover:scale-[1.09] hover:rotate-45 hover:text-accent" />
      </Button>

      <Transition appear show={isOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={resetToCurrent}>
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
          </TransitionChild>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
              <TransitionChild
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <DialogPanel className="w-full max-w-3xl transform rounded-2xl bg-base text-left align-middle shadow-xl transition-all overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-offbase">
                    <DialogTitle as="h3" className="text-lg font-semibold leading-6 text-foreground">
                      Settings
                    </DialogTitle>
                    {authEnabled && (
                      <Button
                        onClick={() => showPrivacyModal({ authEnabled })}
                        className="text-sm font-medium text-muted hover:text-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
                      >
                        Privacy
                      </Button>
                    )}
                  </div>

                  {/* Mobile: 2x2 grid nav */}
                  <div className="grid grid-cols-2 gap-1 sm:hidden border-b border-offbase bg-background p-2">
                    {visibleSections.map((section) => {
                      const Icon = section.icon;
                      return (
                        <button
                          key={section.id}
                          onClick={() => setActiveSection(section.id)}
                          className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors
                            ${activeSection === section.id
                              ? 'bg-accent text-background'
                              : 'text-foreground hover:bg-offbase hover:text-accent'
                            }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {section.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-row h-[450px]">
                    {/* Desktop: vertical sidebar */}
                    <nav className="hidden sm:block w-44 shrink-0 border-r border-offbase bg-background">
                      <div className="flex flex-col p-2 gap-1">
                        {visibleSections.map((section) => {
                          const Icon = section.icon;
                          return (
                            <button
                              key={section.id}
                              onClick={() => setActiveSection(section.id)}
                              className={`w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap
                                ${activeSection === section.id
                                  ? 'bg-accent text-background'
                                  : 'text-foreground hover:bg-offbase hover:text-accent'
                                }`}
                            >
                              <Icon className="w-4 h-4 shrink-0" />
                              {section.label}
                            </button>
                          );
                        })}
                      </div>
                    </nav>

                    {/* Content */}
                    <div className="flex-1 p-4 overflow-y-auto">
                      {/* API Section */}
                      {activeSection === 'api' && (
                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <label className="block text-sm font-medium text-foreground">TTS Provider</label>
                            <Listbox
                              value={ttsProviders.find(p => p.id === localTTSProvider) || ttsProviders[0]}
                              onChange={(provider) => {
                                setLocalTTSProvider(provider.id);
                                if (provider.id === 'openai') {
                                  setModelValue('tts-1');
                                  setLocalBaseUrl('https://api.openai.com/v1');
                                } else if (provider.id === 'custom-openai') {
                                  setModelValue('kokoro');
                                  setLocalBaseUrl('');
                                } else if (provider.id === 'deepinfra') {
                                  setModelValue('hexgrad/Kokoro-82M');
                                  setLocalBaseUrl('https://api.deepinfra.com/v1/openai');
                                }
                                setCustomModelInput('');
                              }}
                            >
                              <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-background py-2 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.005] hover:text-accent hover:bg-offbase">
                                <span className="block truncate">
                                  {ttsProviders.find(p => p.id === localTTSProvider)?.name || 'Select Provider'}
                                </span>
                                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                                  <ChevronUpDownIcon className="h-5 w-5 text-muted" />
                                </span>
                              </ListboxButton>
                              <Transition
                                as={Fragment}
                                leave="transition ease-in duration-100"
                                leaveFrom="opacity-100"
                                leaveTo="opacity-0"
                              >
                                <ListboxOptions className="absolute mt-1 w-full overflow-auto rounded-md bg-background py-1 shadow-lg ring-1 ring-offbase focus:outline-none z-50">
                                  {ttsProviders.map((provider) => (
                                    <ListboxOption
                                      key={provider.id}
                                      className={({ active }) =>
                                        `relative cursor-pointer select-none py-2 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'}`
                                      }
                                      value={provider}
                                    >
                                      {({ selected }) => (
                                        <>
                                          <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                            {provider.name}
                                          </span>
                                          {selected && (
                                            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                              <CheckIcon className="h-5 w-5" />
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </ListboxOption>
                                  ))}
                                </ListboxOptions>
                              </Transition>
                            </Listbox>
                          </div>

                          {(localTTSProvider === 'custom-openai' || !localBaseUrl || localBaseUrl === '') && (
                            <div className="space-y-1.5">
                              <label className="block text-sm font-medium text-foreground">
                                API Base URL
                                {localBaseUrl && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                              </label>
                              <Input
                                type="text"
                                value={localBaseUrl}
                                onChange={(e) => handleInputChange('baseUrl', e.target.value)}
                                placeholder="Using environment variable"
                                className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                              />
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <label className="block text-sm font-medium text-foreground">
                              API Key
                              {localApiKey && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                            </label>
                            <Input
                              type="password"
                              value={localApiKey}
                              onChange={(e) => handleInputChange('apiKey', e.target.value)}
                              placeholder={!showAllDeepInfra && localTTSProvider === 'deepinfra' ? "Deepinfra free or use your API key" : "Using environment variable"}
                              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-sm font-medium text-foreground">TTS Model</label>
                            <div className="flex flex-col gap-2">
                              <Listbox
                                value={ttsModels.find(m => m.id === selectedModelId) || ttsModels[0]}
                                onChange={(model) => {
                                  if (model.id === 'custom') {
                                    setModelValue(customModelInput);
                                  } else {
                                    setModelValue(model.id);
                                    setCustomModelInput('');
                                  }
                                }}
                              >
                                <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-background py-2 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.005] hover:text-accent hover:bg-offbase">
                                  <span className="block truncate">
                                    {ttsModels.find(m => m.id === selectedModelId)?.name || 'Select Model'}
                                  </span>
                                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                                    <ChevronUpDownIcon className="h-5 w-5 text-muted" />
                                  </span>
                                </ListboxButton>
                                <Transition
                                  as={Fragment}
                                  leave="transition ease-in duration-100"
                                  leaveFrom="opacity-100"
                                  leaveTo="opacity-0"
                                >
                                  <ListboxOptions className="absolute mt-1 w-full overflow-auto rounded-md bg-background py-1 shadow-lg ring-1 ring-offbase focus:outline-none z-50">
                                    {ttsModels.map((model) => (
                                      <ListboxOption
                                        key={model.id}
                                        className={({ active }) =>
                                          `relative cursor-pointer select-none py-2 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'}`
                                        }
                                        value={model}
                                      >
                                        {({ selected }) => (
                                          <>
                                            <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                              {model.name}
                                            </span>
                                            {selected && (
                                              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                                <CheckIcon className="h-5 w-5" />
                                              </span>
                                            )}
                                          </>
                                        )}
                                      </ListboxOption>
                                    ))}
                                  </ListboxOptions>
                                </Transition>
                              </Listbox>

                              {supportsCustom && selectedModelId === 'custom' && (
                                <Input
                                  type="text"
                                  value={customModelInput}
                                  onChange={(e) => {
                                    setCustomModelInput(e.target.value);
                                    setModelValue(e.target.value);
                                  }}
                                  placeholder="Enter custom model name"
                                  className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                                />
                              )}
                            </div>
                          </div>

                          {modelValue === 'gpt-4o-mini-tts' && (
                            <div className="space-y-1.5">
                              <label className="block text-sm font-medium text-foreground">TTS Instructions</label>
                              <textarea
                                value={localTTSInstructions}
                                onChange={(e) => setLocalTTSInstructions(e.target.value)}
                                placeholder="Enter instructions for the TTS model"
                                className="w-full h-24 rounded-lg bg-background py-2 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
                              />
                            </div>
                          )}

                          <div className="pt-4 flex justify-end gap-2">
                            <Button
                              type="button"
                              className={`${btnSecondary} px-4 py-2`}
                              onClick={async () => {
                                setLocalApiKey('');
                                setLocalBaseUrl('');
                                setLocalTTSProvider('custom-openai');
                                setModelValue('kokoro');
                                setCustomModelInput('');
                                setLocalTTSInstructions('');
                              }}
                            >
                              Reset
                            </Button>
                            <Button
                              type="button"
                              className={`${btnPrimary} px-4 py-2`}
                              disabled={!canSubmit}
                              onClick={async () => {
                                await updateConfig({
                                  apiKey: localApiKey || '',
                                  baseUrl: localBaseUrl || '',
                                });
                                await updateConfigKey('ttsProvider', localTTSProvider);
                                const finalModel = selectedModelId === 'custom' ? customModelInput.trim() : modelValue;
                                await updateConfigKey('ttsModel', finalModel);
                                await updateConfigKey('ttsInstructions', localTTSInstructions);
                                setIsOpen(false);
                              }}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Theme / Appearance Section */}
                      {activeSection === 'theme' && (
                        <div className="space-y-4">
                          {/* System */}
                          <div className="space-y-1.5">
                            {(() => {
                              const colors = getThemeColors(systemTheme.id);
                              const isActive = theme === systemTheme.id;
                              return (
                                <button
                                  onClick={() => setTheme(systemTheme.id)}
                                  className={`flex items-center gap-3 rounded-lg px-3 py-1.5 w-full text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
                                    ${isActive
                                      ? 'border-accent'
                                      : 'border-offbase hover:border-muted'
                                    }`}
                                  style={{ backgroundColor: colors.base }}
                                >
                                  {isActive ? (
                                    <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                                  ) : (
                                    <span className="w-3.5 shrink-0" />
                                  )}
                                  <span
                                    className="text-xs font-medium w-16 shrink-0"
                                    style={{ color: colors.foreground }}
                                  >
                                    {systemTheme.name}
                                  </span>
                                  <div className="flex gap-1 ml-auto">
                                    <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.background }} />
                                    <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.offbase }} />
                                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.accent }} />
                                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
                                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.muted }} />
                                  </div>
                                </button>
                              );
                            })()}
                          </div>

                          {/* Light themes */}
                          <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-muted uppercase tracking-wide">Light</label>
                            <div className="grid grid-cols-2 gap-1.5">
                              {lightThemes.map((t) => {
                                const colors = getThemeColors(t.id);
                                const isActive = theme === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`flex items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
                                      ${isActive
                                        ? 'border-accent'
                                        : 'border-offbase hover:border-muted'
                                      }`}
                                    style={{ backgroundColor: colors.base }}
                                  >
                                    {isActive ? (
                                      <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                                    ) : (
                                      <span className="w-3.5 shrink-0" />
                                    )}
                                    <span
                                      className="text-xs font-medium w-16 shrink-0"
                                      style={{ color: colors.foreground }}
                                    >
                                      {t.name}
                                    </span>
                                    <div className="flex gap-1 ml-auto">
                                      <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.background }} />
                                      <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.offbase }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.accent }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.muted }} />
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Dark themes */}
                          <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-muted uppercase tracking-wide">Dark</label>
                            <div className="grid grid-cols-2 gap-1.5">
                              {darkThemes.map((t) => {
                                const colors = getThemeColors(t.id);
                                const isActive = theme === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`flex items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
                                      ${isActive
                                        ? 'border-accent'
                                        : 'border-offbase hover:border-muted'
                                      }`}
                                    style={{ backgroundColor: colors.base }}
                                  >
                                    {isActive ? (
                                      <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                                    ) : (
                                      <span className="w-3.5 shrink-0" />
                                    )}
                                    <span
                                      className="text-xs font-medium w-16 shrink-0"
                                      style={{ color: colors.foreground }}
                                    >
                                      {t.name}
                                    </span>
                                    <div className="flex gap-1 ml-auto">
                                      <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.background }} />
                                      <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.offbase }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.accent }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
                                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.muted }} />
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Documents Section */}
                      {activeSection === 'docs' && (
                        <div className="space-y-5">
                          <div className="space-y-2">
                            <label className="block text-sm font-medium text-foreground">Server Library</label>
                            <Button
                              onClick={handleImportLibrary}
                              disabled={isBusy}
                              className={`${btnOutline} px-4 py-2 disabled:opacity-50`}
                            >
                              {isImportingLibrary ? `Importing... ${Math.round(progress)}%` : 'Import from library'}
                            </Button>
                          </div>

                          <div className="space-y-2">
                            <label className="block text-sm font-medium text-foreground">Cache & Data</label>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                onClick={handleRefresh}
                                disabled={isBusy}
                                className={`${btnOutline} px-4 py-2 disabled:opacity-50`}
                              >
                                Refresh
                              </Button>
                              <Button
                                onClick={handleClearCache}
                                disabled={isBusy}
                                className={`${btnOutline} px-4 py-2 disabled:opacity-50`}
                              >
                                Clear cache
                              </Button>
                              {enableDestructiveDelete && !authEnabled && (
                                <Button
                                  onClick={() => setShowDeleteDocsConfirm(true)}
                                  disabled={isBusy}
                                  className={`${btnBase} bg-red-600 text-white hover:bg-red-700 hover:scale-[1.04] px-4 py-2`}
                                >
                                  Delete all data
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Account Section */}
                      {activeSection === 'account' && authEnabled && (
                        <div className="space-y-2">
                          {/* Session info */}
                          <div className="rounded-lg bg-background border border-offbase p-4 space-y-2">
                            <h4 className="text-sm font-medium text-foreground">Current Session</h4>
                            <div className="text-sm space-y-1">
                              <p className="text-muted">Logged in as:</p>
                              {session?.user ? (
                                <>
                                  <p className="font-medium text-foreground">
                                    {session.user.isAnonymous
                                      ? 'Anonymous'
                                      : (session.user.name || session.user.email || 'Account')}
                                  </p>
                                  {!session.user.isAnonymous && (
                                    <p className="text-xs text-muted font-mono">{session.user.email}</p>
                                  )}
                                  {session.user.isAnonymous && (
                                    <p className="text-xs text-accent mt-1">Anonymous session</p>
                                  )}
                                </>
                              ) : (
                                <p className="font-medium text-foreground">No active session</p>
                              )}
                            </div>
                          </div>

                          {/* Export Data */}
                          {session?.user && (
                            <button
                              onClick={() => {
                                window.open('/api/user/export', '_blank');
                              }}
                              className="w-full rounded-lg border border-offbase bg-background p-4 flex items-center gap-4 hover:bg-offbase transition-colors text-left group"
                            >
                              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-offbase flex items-center justify-center group-hover:bg-background transition-colors">
                                <DownloadIcon className="w-5 h-5 text-accent" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-foreground">Export My Data</p>
                                <p className="text-xs text-muted">Download all your data as a ZIP file</p>
                              </div>
                            </button>
                          )}

                          {/* Actions */}
                          <div className="space-y-2">
                            {session?.user && !session.user.isAnonymous ? (
                              <>
                                <Button
                                  onClick={handleSignOut}
                                  className={`${btnOutline} px-4 py-2`}
                                >
                                  Disconnect account
                                </Button>

                                <div className="pt-4 mt-4 border-t border-offbase">
                                  <label className="block text-sm font-medium text-red-500 mb-2">Danger Zone</label>
                                  <Button
                                    onClick={() => setShowDeleteAccountConfirm(true)}
                                    className={`${btnBase} bg-red-600 text-white border border-red-700 hover:bg-red-700 hover:scale-[1.02] px-4 py-2`}
                                  >
                                    Delete Account
                                  </Button>
                                  <p className="text-xs text-muted mt-2">
                                    Permanently deletes your account and all data.
                                  </p>
                                </div>
                              </>
                            ) : (
                              <div className="pt-2 border-t border-offbase">
                                <p className="text-sm text-muted mb-3">
                                  {session?.user?.isAnonymous
                                    ? 'You are using an anonymous session. Sign up to save your progress permanently, your current data is automatically transferred.'
                                    : 'No active session. Please sign in or create an account.'}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  <Link href="/signin">
                                    <Button className={`${btnOutline} px-4 py-2`}>
                                      Connect
                                    </Button>
                                  </Link>
                                  <Link href="/signup">
                                    <Button className={`${btnPrimary} px-4 py-2`}>
                                      Create account
                                    </Button>
                                  </Link>
                                  <Link href="/?redirect=false">
                                    <Button className={`${btnOutline} px-4 py-2`}>
                                      Back to landing page
                                    </Button>
                                  </Link>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </DialogPanel>
              </TransitionChild>
            </div>
          </div>
        </Dialog>
      </Transition>

      <ConfirmDialog
        isOpen={showDeleteDocsConfirm}
        onClose={() => setShowDeleteDocsConfirm(false)}
        onConfirm={handleDeleteDocs}
        title="Delete All Data"
        message="Are you sure you want to delete all documents from the server? This action cannot be undone."
        confirmText="Delete"
        isDangerous={true}
      />

      <ConfirmDialog
        isOpen={showDeleteAccountConfirm}
        onClose={() => setShowDeleteAccountConfirm(false)}
        onConfirm={handleDeleteAccount}
        title="Delete Account"
        message="Are you sure you want to delete your account? This action cannot be undone and all your data will be lost."
        confirmText="Delete Account"
        isDangerous={true}
      />

      <ProgressPopup
        isOpen={showProgress}
        progress={progress}
        estimatedTimeRemaining={estimatedTimeRemaining || undefined}
        onCancel={() => {
          if (abortController) {
            abortController.abort();
          }
          setShowProgress(false);
          setProgress(0);
          setIsImportingLibrary(false);
          setStatusMessage('');
          setAbortController(null);
        }}
        statusMessage={statusMessage}
        operationType="library"
        cancelText="Cancel"
      />
      <DocumentSelectionModal
        isOpen={isSelectionModalOpen}
        onClose={() => !isBusy && setIsSelectionModalOpen(false)}
        onConfirm={handleModalConfirm}
        title={selectionModalProps.title}
        confirmLabel={selectionModalProps.confirmLabel}
        isProcessing={false}
        defaultSelected={selectionModalProps.defaultSelected}
        initialFiles={selectionModalProps.initialFiles}
        fetcher={selectionModalProps.fetcher}
      />
    </>
  );
}
