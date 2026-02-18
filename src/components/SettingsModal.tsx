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
  TabGroup,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
} from '@headlessui/react';
import Link from 'next/link';
import { useTheme } from '@/contexts/ThemeContext';
import { useConfig } from '@/contexts/ConfigContext';
import { ChevronUpDownIcon, CheckIcon, SettingsIcon } from '@/components/icons/Icons';
import { getAppConfig, getFirstVisit, setFirstVisit } from '@/lib/dexie';
import { useDocuments } from '@/contexts/DocumentContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProgressPopup } from '@/components/ProgressPopup';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { THEMES } from '@/contexts/ThemeContext';
import { DocumentSelectionModal } from '@/components/documents/DocumentSelectionModal';
import { BaseDocument } from '@/types/documents';
import { getAuthClient } from '@/lib/auth-client';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRouter } from 'next/navigation';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { deleteDocuments, mimeTypeForDoc, uploadDocuments } from '@/lib/client-documents';
import { cacheStoredDocumentFromBytes, clearDocumentCache } from '@/lib/document-cache';
import { clearAllDocumentPreviewCaches, clearInMemoryDocumentPreviewCache } from '@/lib/document-preview-cache';

const enableDestructiveDelete = process.env.NEXT_PUBLIC_ENABLE_DESTRUCTIVE_DELETE_ACTIONS !== 'false';
const showAllDeepInfra = process.env.NEXT_PUBLIC_SHOW_ALL_DEEPINFRA_MODELS !== 'false';


const themes = THEMES.map(id => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1)
}));

export function SettingsModal({ className = '' }: { className?: string }) {
  const [isOpen, setIsOpen] = useState(false);

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
  const selectedTheme = themes.find(t => t.id === theme) || themes[0];
  const [showDeleteDocsConfirm, setShowDeleteDocsConfirm] = useState(false);
  const [deleteDocsMode, setDeleteDocsMode] = useState<'user' | 'unclaimed'>('user');
  const [showDeleteAccountConfirm, setShowDeleteAccountConfirm] = useState(false);
  const { progress, setProgress, estimatedTimeRemaining } = useTimeEstimation();
  const { authEnabled, baseUrl: authBaseUrl, allowAnonymousAuthSessions } = useAuthConfig();
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
          { id: 'orpheus', name: 'Orpheus' },
          { id: 'custom', name: 'Other' }
        ];
      case 'deepinfra':
        // In production without an API key, limit to free tier model
        if (!showAllDeepInfra && !localApiKey) {
          return [
            { id: 'hexgrad/Kokoro-82M', name: 'hexgrad/Kokoro-82M' }
          ];
        }
        // In dev or with an API key, allow all models
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

  // Open settings on first visit (stored in Dexie app config)
  const checkFirstVist = useCallback(async () => {
    const appConfig = await getAppConfig();
    if (!appConfig?.privacyAccepted) {
      return;
    }
    const firstVisit = await getFirstVisit();
    if (!firstVisit) {
      await setFirstVisit(true);
      setIsOpen(true);
    }
  }, [setIsOpen]);

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
    const onPrivacyAccepted = () => {
      checkFirstVist().catch((err) => {
        console.error('First visit check after privacy acceptance failed:', err);
      });
    };
    window.addEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    return () => {
      window.removeEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    };
  }, [checkFirstVist]);

  // Detect if current model is custom (not in presets) and mirror it in the input field
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

    // Close modal? Maybe keep open until started?
    // Let's close it here, process starts.
    // Actually we keep it open if we want to show loading state INSIDE modal?
    // But existing UI uses a separate ProgressPopup.
    // So close modal, show popup.
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
      if (deleteDocsMode === 'user') {
        await deleteDocuments();
        await refreshDocuments().catch(() => { });
      } else if (deleteDocsMode === 'unclaimed') {
        await deleteDocuments({ scope: 'unclaimed' });
        await refreshDocuments().catch(() => { });
      }
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

      // Sign out locally
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

  const tabs = [
    { name: 'API', icon: '🔑' },
    { name: 'Theme', icon: '✨' },
    { name: 'Docs', icon: '📄' },
    ...(authEnabled ? [{ name: 'User', icon: '👤' }] : [])
  ];

  const isAnonymous = Boolean(session?.user?.isAnonymous);

  const userDeleteLabel = authEnabled ? (isAnonymous ? 'Delete anonymous docs' : 'Delete all user docs') : 'Delete server docs';
  const userDeleteTitle = authEnabled ? (isAnonymous ? 'Delete Anonymous Docs' : 'Delete All User Docs') : 'Delete Server Docs';
  const userDeleteMessage = authEnabled
    ? (isAnonymous
      ? 'Are you sure you want to delete all anonymous-session documents? This action cannot be undone.'
      : 'Are you sure you want to delete all of your documents from the server? This action cannot be undone.')
    : 'Are you sure you want to delete all documents from the server? This action cannot be undone.';

  const [unclaimedCounts, setUnclaimedCounts] = useState<{ documents: number; audiobooks: number } | null>(null);
  const canDeleteUnclaimed =
    authEnabled && session?.user && !isAnonymous && (unclaimedCounts?.documents ?? 0) > 0;

  useEffect(() => {
    if (!authEnabled) return;
    if (!session?.user) return;
    if (session.user.isAnonymous) return;
    // fetch claimable counts (unclaimed docs/audiobooks)
    fetch('/api/user/claim')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.documents === 'number' && typeof data.audiobooks === 'number') {
          setUnclaimedCounts({ documents: data.documents, audiobooks: data.audiobooks });
        }
      })
      .catch(() => { });
  }, [authEnabled, session?.user]);

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
                <DialogPanel className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <DialogTitle
                      as="h3"
                      className="text-lg font-semibold leading-6 text-foreground"
                    >
                      Settings
                    </DialogTitle>

                    <Button
                      onClick={() => showPrivacyModal({ authEnabled })}
                      className="text-sm font-medium text-muted hover:text-accent"
                    >
                      Privacy
                    </Button>
                  </div>

                  <TabGroup>
                    <TabList className="flex flex-col sm:flex-col-none sm:flex-row gap-1 rounded-xl bg-background p-1 mb-4">
                      {tabs.map((tab) => (
                        <Tab
                          key={tab.name}
                          className={({ selected }) =>
                            `w-full rounded-lg py-1 text-sm font-medium
                             ring-accent/60 ring-offset-2 ring-offset-base
                             ${selected
                              ? 'bg-accent text-background shadow'
                              : 'text-foreground hover:text-accent'
                            }`
                          }
                        >
                          <span className="flex items-center justify-center gap-2">
                            <span>{tab.icon}</span>
                            {tab.name}
                          </span>
                        </Tab>
                      ))}
                    </TabList>
                    <TabPanels className="mt-2">
                      <TabPanel className="space-y-2.5">
                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">TTS Provider</label>
                          <Listbox
                            value={ttsProviders.find(p => p.id === localTTSProvider) || ttsProviders[0]}
                            onChange={(provider) => {
                              setLocalTTSProvider(provider.id);
                              // Set default model and base_url for each provider
                              if (provider.id === 'openai') {
                                setModelValue('tts-1');
                                setLocalBaseUrl('https://api.openai.com/v1');
                              } else if (provider.id === 'custom-openai') {
                                setModelValue('kokoro');
                                // Clear baseUrl for custom provider
                                setLocalBaseUrl('');
                              } else if (provider.id === 'deepinfra') {
                                setModelValue('hexgrad/Kokoro-82M');
                                setLocalBaseUrl('https://api.deepinfra.com/v1/openai');
                              }
                              setCustomModelInput('');
                            }}
                          >
                            <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-background py-1.5 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.009] hover:text-accent hover:bg-offbase">
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
                              <ListboxOptions className="absolute mt-1 w-full overflow-auto rounded-md bg-background py-1 shadow-lg ring-1 ring-black/5 focus:outline-none z-50">
                                {ttsProviders.map((provider) => (
                                  <ListboxOption
                                    key={provider.id}
                                    className={({ active }) =>
                                      `relative cursor-pointer select-none py-1.5 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'
                                      }`
                                    }
                                    value={provider}
                                  >
                                    {({ selected }) => (
                                      <>
                                        <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                          {provider.name}
                                        </span>
                                        {selected ? (
                                          <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                            <CheckIcon className="h-5 w-5" />
                                          </span>
                                        ) : null}
                                      </>
                                    )}
                                  </ListboxOption>
                                ))}
                              </ListboxOptions>
                            </Transition>
                          </Listbox>
                        </div>

                        {(localTTSProvider === 'custom-openai' || !localBaseUrl || localBaseUrl === '') && (
                          <div className="space-y-1">
                            <label className="block text-sm font-medium text-foreground">
                              API Base URL
                              {localBaseUrl && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                            </label>
                            <div className="flex gap-2">
                              <Input
                                type="text"
                                value={localBaseUrl}
                                onChange={(e) => handleInputChange('baseUrl', e.target.value)}
                                placeholder="Using environment variable"
                                className="w-full rounded-lg bg-background py-1.5 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                              />
                            </div>
                          </div>
                        )}

                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">
                            API Key
                            {localApiKey && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                          </label>
                          <div className="flex gap-2">
                            <Input
                              type="password"
                              value={localApiKey}
                              onChange={(e) => handleInputChange('apiKey', e.target.value)}
                              placeholder={!showAllDeepInfra && localTTSProvider === 'deepinfra' ? "Deepinfra free or use your API key" : "Using environment variable"}
                              className="w-full rounded-lg bg-background py-1.5 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">TTS Model</label>
                          <div className="flex flex-col gap-2">
                            <Listbox
                              value={ttsModels.find(m => m.id === selectedModelId) || ttsModels[0]}
                              onChange={(model) => {
                                if (model.id === 'custom') {
                                  // Switch to custom: keep the current custom input (or empty)
                                  setModelValue(customModelInput);
                                } else {
                                  setModelValue(model.id);
                                  setCustomModelInput('');
                                }
                              }}
                            >
                              <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-background py-1.5 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.009] hover:text-accent hover:bg-offbase">
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
                                <ListboxOptions className="absolute mt-1 w-full overflow-auto rounded-md bg-background py-1 shadow-lg ring-1 ring-black/5 focus:outline-none z-50">
                                  {ttsModels.map((model) => (
                                    <ListboxOption
                                      key={model.id}
                                      className={({ active }) =>
                                        `relative cursor-pointer select-none py-1.5 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'
                                        }`
                                      }
                                      value={model}
                                    >
                                      {({ selected }) => (
                                        <>
                                          <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                            {model.name}
                                          </span>
                                          {selected ? (
                                            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                              <CheckIcon className="h-5 w-5" />
                                            </span>
                                          ) : null}
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
                                className="w-full rounded-lg bg-background py-1.5 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                              />
                            )}
                          </div>
                        </div>

                        {modelValue === 'gpt-4o-mini-tts' && (
                          <div className="space-y-1">
                            <label className="block text-sm font-medium text-foreground">TTS Instructions</label>
                            <textarea
                              value={localTTSInstructions}
                              onChange={(e) => setLocalTTSInstructions(e.target.value)}
                              placeholder="Enter instructions for the TTS model"
                              className="w-full h-24 rounded-lg bg-background py-1.5 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>
                        )}

                        <div className="pt-4 flex justify-end gap-2">
                          <Button
                            type="button"
                            className="inline-flex justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                               font-medium text-foreground hover:bg-offbase focus:outline-none 
                               focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                               transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
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
                            className="inline-flex justify-center rounded-lg bg-accent px-3 py-1.5 text-sm 
                               font-medium text-background hover:bg-secondary-accent focus:outline-none 
                               focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                               transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-background"
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
                      </TabPanel>

                      <TabPanel className="space-y-4 pb-3">
                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">Theme</label>
                          <Listbox value={selectedTheme} onChange={(newTheme) => setTheme(newTheme.id)}>
                            <ListboxButton className="relative w-full cursor-pointer rounded-lg bg-background py-1.5 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.009] hover:text-accent hover:bg-offbase">
                              <span className="block truncate">{selectedTheme.name}</span>
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
                              <ListboxOptions className="absolute mt-1 w-full overflow-auto rounded-md bg-background py-1 shadow-lg ring-1 ring-black/5 focus:outline-none">
                                {themes.map((theme) => (
                                  <ListboxOption
                                    key={theme.id}
                                    className={({ active }) =>
                                      `relative cursor-pointer select-none py-1.5 pl-10 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'
                                      }`
                                    }
                                    value={theme}
                                  >
                                    {({ selected }) => (
                                      <>
                                        <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                          {theme.name}
                                        </span>
                                        {selected ? (
                                          <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-accent">
                                            <CheckIcon className="h-5 w-5" />
                                          </span>
                                        ) : null}
                                      </>
                                    )}
                                  </ListboxOption>
                                ))}
                              </ListboxOptions>
                            </Transition>
                          </Listbox>
                        </div>
                      </TabPanel>

                      <TabPanel className="space-y-4">
                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">Server Library Import</label>
                          <div className="flex gap-2">
                            <Button
                              onClick={handleImportLibrary}
                              disabled={isBusy}
                              className="justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                                       font-medium text-foreground hover:bg-offbase focus:outline-none 
                                       focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                       transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent
                                       disabled:opacity-50"
                            >
                              {isImportingLibrary ? `Importing... ${Math.round(progress)}%` : 'Import from library'}
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-foreground">Documents</label>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              onClick={handleRefresh}
                              disabled={isBusy}
                              className="justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                                       font-medium text-foreground hover:bg-offbase focus:outline-none 
                                       focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                       transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent
                                       disabled:opacity-50"
                            >
                              Refresh
                            </Button>
                            <Button
                              onClick={handleClearCache}
                              disabled={isBusy}
                              className="justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                                       font-medium text-foreground hover:bg-offbase focus:outline-none 
                                       focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                       transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent
                                       disabled:opacity-50"
                            >
                              Clear cache
                            </Button>
                            {enableDestructiveDelete && (
                              <div className="flex w-full gap-2">
                                <Button
                                  onClick={() => {
                                    setDeleteDocsMode('user');
                                    setShowDeleteDocsConfirm(true);
                                  }}
                                  disabled={isBusy}
                                  className="justify-center rounded-lg bg-red-500 px-3 py-1.5 text-sm 
                                         font-medium text-background hover:bg-red-500/90 focus:outline-none 
                                         focus-visible:ring-2 focus-visible:bg-red-500 focus-visible:ring-offset-2
                                       transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
                                >
                                  {userDeleteLabel}
                                </Button>
                                {canDeleteUnclaimed && (
                                  <Button
                                    onClick={() => {
                                      setDeleteDocsMode('unclaimed');
                                      setShowDeleteDocsConfirm(true);
                                    }}
                                    disabled={isBusy}
                                    className="justify-center rounded-lg bg-red-500 px-3 py-1.5 text-sm 
                                         font-medium text-background hover:bg-red-500/90 focus:outline-none 
                                         focus-visible:ring-2 focus-visible:bg-red-500 focus-visible:ring-offset-2
                                       transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
                                  >
                                    Delete unclaimed docs
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </TabPanel>

                      {authEnabled && (
                        <TabPanel className="space-y-4">
                          <div className="space-y-4">
                            <div className="rounded-lg bg-offbase p-4 space-y-3">
                              <h4 className="font-medium text-foreground">Current Session</h4>
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

                            <div className="space-y-2">
                              {session?.user && (
                                <Button
                                  onClick={() => {
                                    window.open('/api/user/export', '_blank');
                                  }}
                                  className="w-full flex flex-col items-center justify-center rounded-lg bg-background border border-offbase px-3 py-2 text-sm 
                                           font-medium text-foreground hover:bg-offbase focus:outline-none 
                                           focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                           transform transition-transform duration-200 ease-in-out hover:scale-[1.02]"
                                >
                                  <span>Export My Data</span>
                                  <span className="text-xs text-muted font-normal mt-0.5">Download metadata, uploaded documents, and generated audiobooks (ZIP)</span>
                                </Button>
                              )}

                              {session?.user && !session.user.isAnonymous ? (
                                <>
                                  <Button
                                    onClick={handleSignOut}
                                    className="w-full justify-center rounded-lg bg-background border border-offbase px-3 py-2 text-sm 
                                             font-medium text-foreground hover:bg-offbase focus:outline-none 
                                             focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                             transform transition-transform duration-200 ease-in-out hover:scale-[1.02]"
                                  >
                                    Disconnect account
                                  </Button>

                                  <div className="pt-4 border-t border-offbase">
                                    <label className="block text-sm font-medium text-red-500 mb-2">Danger Zone</label>
                                    <Button
                                      onClick={() => setShowDeleteAccountConfirm(true)}
                                      className="w-full justify-center rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm 
                                               font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 focus:outline-none 
                                               focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2
                                               transform transition-transform duration-200 ease-in-out hover:scale-[1.02]"
                                    >
                                      Delete Account
                                    </Button>
                                    <p className="text-xs text-muted mt-2 text-center">
                                      This will permanently delete your account and data. You will be redirected to sign up.
                                    </p>
                                  </div>
                                </>
                              ) : (
                                <div className="pt-2 border-t border-offbase">
                                  <p className="text-sm text-muted mb-3">
                                    {session?.user?.isAnonymous
                                      ? (allowAnonymousAuthSessions
                                        ? 'You are using an anonymous session. Sign up to save your progress permanently.'
                                        : 'Anonymous sessions are disabled. Please sign in or create an account.')
                                      : 'No active session. Please sign in or create an account.'}
                                  </p>
                                  <div className="grid grid-cols-2 gap-3">
                                    <Link href="/signin" className="w-full">
                                      <Button className="w-full justify-center rounded-lg bg-background border border-offbase px-3 py-2 text-sm font-medium text-foreground hover:bg-offbase focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base transform transition-transform duration-200 ease-in-out hover:scale-[1.02]">
                                        Connect
                                      </Button>
                                    </Link>
                                    <Link href="/signup" className="w-full">
                                      <Button className="w-full justify-center rounded-lg bg-accent px-3 py-2 text-sm font-medium text-background hover:bg-secondary-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base transform transition-transform duration-200 ease-in-out hover:scale-[1.02]">
                                        Create account
                                      </Button>
                                    </Link>
                                  </div>
                                  <Link href="/?redirect=false" className="block mt-3">
                                    <Button className="w-full justify-center rounded-lg bg-background border border-offbase px-3 py-2 text-sm font-medium text-foreground hover:bg-offbase focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base transform transition-transform duration-200 ease-in-out hover:scale-[1.02]">
                                      Back to landing page
                                    </Button>
                                  </Link>
                                </div>
                              )}
                            </div>
                          </div>
                        </TabPanel>
                      )}
                    </TabPanels>
                  </TabGroup>
                </DialogPanel>
              </TransitionChild>
            </div>
          </div>
        </Dialog>
      </Transition >

      <ConfirmDialog
        isOpen={showDeleteDocsConfirm}
        onClose={() => setShowDeleteDocsConfirm(false)}
        onConfirm={handleDeleteDocs}
        title={
          deleteDocsMode === 'unclaimed'
            ? 'Delete Unclaimed Docs'
            : userDeleteTitle
        }
        message={
          deleteDocsMode === 'unclaimed'
            ? 'Are you sure you want to delete all unclaimed documents? This action cannot be undone.'
            : userDeleteMessage
        }
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
        isProcessing={false} // Processing happens in ProgressPopup after closing
        defaultSelected={selectionModalProps.defaultSelected}
        initialFiles={selectionModalProps.initialFiles}
        fetcher={selectionModalProps.fetcher}
      />
    </>
  );
}
