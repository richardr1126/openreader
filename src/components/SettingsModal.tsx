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
import { ChevronUpDownIcon, CheckIcon, SettingsIcon, KeyIcon, PaletteIcon, DocumentIcon, UserIcon, DownloadIcon, ChevronRightIcon } from '@/components/icons/Icons';
import { useDocuments } from '@/contexts/DocumentContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProgressPopup } from '@/components/ProgressPopup';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { THEMES, getCustomThemeColors, type CustomThemeColors } from '@/contexts/ThemeContext';
import { ColorPicker } from '@/components/ColorPicker';
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
import { resolveTtsSettingsViewModel } from '@/lib/client/settings/tts-settings';
import {
  isBuiltInTtsProviderId,
  type TtsProviderType,
} from '@/lib/shared/tts-provider-catalog';
import {
  defaultBaseUrlForProviderType,
  defaultModelForProviderType,
  resolveProviderDefaults,
  resolveEffectiveProviderType,
  resolveTtsProviderModelPolicy,
} from '@/lib/shared/tts-provider-policy';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { AdminProvidersPanel } from '@/components/admin/AdminProvidersPanel';
import { AdminFeaturesPanel } from '@/components/admin/AdminFeaturesPanel';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useLibraryDocumentsQuery } from '@/hooks/useLibraryDocumentsQuery';
import {
  buttonClass,
  inputClass,
  listboxButtonClass,
  listboxOptionClass,
  listboxOptionsClass,
  segmentedButtonClass,
  segmentedGroupClass,
} from '@/components/formPrimitives';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchChangelogManifest, fetchChangelogReleaseBody } from '@/lib/client/changelog';
import {
  findCurrentVersionIndex,
  normalizeVersion,
  type ChangelogManifestEntry,
  type ChangelogReleaseBody,
} from '@/lib/shared/changelog';
import { useOnboardingFlow } from '@/contexts/OnboardingFlowContext';

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

const allThemes = THEMES.filter(id => id !== 'custom').map(id => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
}));

const systemTheme = allThemes.find(t => t.id === 'system')!;
const lightThemes = allThemes.filter(t => LIGHT_THEME_IDS.has(t.id));
const darkThemes = allThemes.filter(t => t.id !== 'system' && !LIGHT_THEME_IDS.has(t.id));

const CUSTOM_COLOR_FIELDS: { key: keyof CustomThemeColors; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'base', label: 'Base' },
  { key: 'offbase', label: 'Off-base' },
  { key: 'accent', label: 'Accent' },
  { key: 'secondaryAccent', label: 'Accent 2' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'muted', label: 'Muted' },
];

type SectionId = 'api' | 'theme' | 'docs' | 'account' | 'admin';

type SidebarSection = {
  id: SectionId;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  authOnly?: boolean;
  adminOnly?: boolean;
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: 'api', label: 'TTS Provider', icon: KeyIcon },
  { id: 'theme', label: 'Appearance', icon: PaletteIcon },
  { id: 'docs', label: 'Documents', icon: DocumentIcon },
  { id: 'account', label: 'Account', icon: UserIcon, authOnly: true },
  { id: 'admin', label: 'Admin', icon: SettingsIcon, authOnly: true, adminOnly: true },
];

type AdminSubTab = 'providers' | 'features';

export function SettingsModal({
  className = '',
  triggerLabel,
}: {
  className?: string;
  triggerLabel?: string;
}) {
  const runtimeConfig = useRuntimeConfig();
  const enableDestructiveDelete = runtimeConfig.enableDestructiveDeleteActions;
  const showAllProviderModels = runtimeConfig.showAllProviderModels;
  const enableTTSProvidersTab = runtimeConfig.enableTtsProvidersTab;
  const restrictUserApiKeys = runtimeConfig.restrictUserApiKeys;
  const [isOpen, setIsOpen] = useState(false);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>(enableTTSProvidersTab ? 'api' : 'theme');

  const { theme, setTheme, applyCustomColors } = useTheme();
  const [customColors, setCustomColors] = useState<CustomThemeColors>(getCustomThemeColors);
  const [isCustomExpanded, setIsCustomExpanded] = useState(false);
  const { apiKey, baseUrl, providerRef, providerType, ttsModel, ttsInstructions, updateConfig, updateConfigKey } = useConfig();
  const { refreshDocuments } = useDocuments();
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl);
  const [localProviderRef, setLocalProviderRef] = useState(providerRef);
  const [localProviderType, setLocalProviderType] = useState<TtsProviderType>(providerType);
  const [modelValue, setModelValue] = useState(ttsModel);
  const [customModelInput, setCustomModelInput] = useState('');
  const [localTTSInstructions, setLocalTTSInstructions] = useState(ttsInstructions);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [selectionModalProps, setSelectionModalProps] = useState<{
    title: string;
    confirmLabel: string;
    defaultSelected: boolean;
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
  const { changelogOpenSignal } = useOnboardingFlow();
  const router = useRouter();
  const isBusy = isImportingLibrary;
  const {
    documents: libraryDocuments,
    isLoading: isLibraryDocumentsLoading,
    errorMessage: libraryDocumentsErrorMessage,
    prefetch: prefetchLibraryDocuments,
  } = useLibraryDocumentsQuery(isSelectionModalOpen);

  const { providers: sharedProviders } = useSharedProviders();
  const {
    providers: ttsProviders,
    models: ttsModels,
    supportsCustomModel: supportsCustom,
    selectedModelId,
    canSubmit,
    selectedSharedProvider,
    selectedProviderRef,
    selectedProviderType,
  } = useMemo(() => resolveTtsSettingsViewModel({
    providerRef: localProviderRef,
    providerType: localProviderType,
    apiKey: localApiKey,
    modelValue,
    customModelInput,
    showAllProviderModels,
    sharedProviders,
    allowBuiltInProviders: !restrictUserApiKeys,
  }), [localProviderRef, localProviderType, localApiKey, modelValue, customModelInput, showAllProviderModels, sharedProviders, restrictUserApiKeys]);
  const isSharedSelected = Boolean(selectedSharedProvider);
  const selectedProviderOption = ttsProviders.find((p) => p.id === localProviderRef) ?? ttsProviders[0];

  useEffect(() => {
    if (changelogOpenSignal <= 0) return;
    setIsOpen(true);
    setIsChangelogOpen(true);
  }, [changelogOpenSignal]);

  useEffect(() => {
    setLocalApiKey(apiKey);
    setLocalBaseUrl(baseUrl);
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setLocalTTSInstructions(ttsInstructions);
  }, [apiKey, baseUrl, providerRef, providerType, ttsModel, ttsInstructions]);

  useEffect(() => {
    if (!ttsModels.some(m => m.id === modelValue) && modelValue !== '') {
      setCustomModelInput(modelValue);
    } else {
      setCustomModelInput('');
    }
  }, [modelValue, ttsModels]);

  useEffect(() => {
    if (selectedProviderOption) return;
    if (ttsProviders.length === 0) return;

    const fallback = ttsProviders[0];
    setLocalProviderRef(fallback.id);
    setLocalProviderType(fallback.providerType);

    if (fallback.shared) {
      const shared = sharedProviders.find((p) => p.slug === fallback.id);
      if (shared?.defaultModel) {
        setModelValue(shared.defaultModel);
      }
      setLocalTTSInstructions(shared?.defaultInstructions ?? '');
      setLocalApiKey('');
      setLocalBaseUrl('');
      setCustomModelInput('');
      return;
    }

    if (isBuiltInTtsProviderId(fallback.providerType)) {
      setModelValue(defaultModelForProviderType(fallback.providerType));
      setLocalBaseUrl(defaultBaseUrlForProviderType(fallback.providerType));
      setCustomModelInput('');
    }
  }, [selectedProviderOption, ttsProviders, sharedProviders]);

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
    // Start fetching as soon as the user opens the picker so cached data is
    // often ready before the modal asks for it.
    void prefetchLibraryDocuments();
    setSelectionModalProps({
      title: 'Import from Library',
      confirmLabel: 'Import',
      defaultSelected: false,
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
      window.location.href = runtimeConfig.enableUserSignups ? '/signup' : '/signin';
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
    setIsChangelogOpen(false);
    setLocalApiKey(apiKey);
    setLocalBaseUrl(baseUrl);
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setLocalTTSInstructions(ttsInstructions);
    if (!ttsModels.some(m => m.id === ttsModel) && ttsModel !== '') {
      setCustomModelInput(ttsModel);
    } else {
      setCustomModelInput('');
    }
  }, [apiKey, baseUrl, providerRef, providerType, ttsModel, ttsInstructions, ttsModels]);

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
    if (id === 'custom') {
      return {
        background: customColors.background,
        base: customColors.base,
        offbase: customColors.offbase,
        accent: customColors.accent,
        secondaryAccent: customColors.secondaryAccent,
        foreground: customColors.foreground,
        muted: customColors.muted,
      };
    }
    return THEME_COLORS[id] || THEME_COLORS.light;
  }, [systemIsDark, customColors]);

  const isAdmin = Boolean(
    (session?.user as unknown as { isAdmin?: boolean } | undefined)?.isAdmin,
  );
  const [adminSubTab, setAdminSubTab] = useState<AdminSubTab>('providers');
  const visibleSections = useMemo(
    () => SIDEBAR_SECTIONS.filter((section) => {
      if (section.id === 'api' && !enableTTSProvidersTab) {
        return false;
      }
      if (section.authOnly && !authEnabled) return false;
      if (section.adminOnly && !isAdmin) return false;
      return true;
    }),
    [authEnabled, isAdmin, enableTTSProvidersTab]
  );

  useEffect(() => {
    if (visibleSections.some(section => section.id === activeSection)) {
      return;
    }
    setActiveSection(visibleSections[0]?.id ?? 'theme');
  }, [activeSection, visibleSections]);

  const fieldLabelClass = 'block text-[11px] font-semibold uppercase tracking-wide text-muted';
  const sectionShellClass = 'space-y-2 pb-3 border-b border-offbase px-0.5';
  const sectionHeadingClass = 'text-sm font-semibold text-foreground';
  const effectiveProviderType = resolveEffectiveProviderType({
    providerRef: selectedProviderRef,
    providerType: localProviderType,
    sharedProviders,
  });
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: selectedProviderRef,
    providerType: effectiveProviderType,
    model: modelValue,
    sharedProviders,
  });
  const shouldShowBaseUrl = !restrictUserApiKeys
    && !isSharedSelected
    && providerModelPolicy.isResolvedProviderType
    && providerModelPolicy.providerType !== 'replicate'
    && (providerModelPolicy.providerType === 'custom-openai' || !localBaseUrl || localBaseUrl === '');
  const shouldShowApiKey = !restrictUserApiKeys && !isSharedSelected;
  const selectedModel = ttsModels.find(m => m.id === selectedModelId) || ttsModels[0];
  const selectedModelVersion = selectedModel?.id?.includes(':')
    ? selectedModel.id.slice(selectedModel.id.indexOf(':'))
    : '';
  const displayVersion = normalizeVersion(runtimeConfig.appVersion || '');

  return (
    <>
      <Button
        onClick={() => {
          setIsOpen(true);
          setIsChangelogOpen(false);
        }}
        className={`inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase hover:text-accent transition-transform transition-colors duration-200 ease-out hover:scale-[1.01] ${className}`}
        aria-label="Settings"
        tabIndex={0}
      >
        <SettingsIcon className="w-4 h-4 transition-transform duration-200 ease-out hover:scale-[1.01] hover:rotate-45" />
        {triggerLabel && <span className="ml-2">{triggerLabel}</span>}
      </Button>

      <Transition appear show={isOpen} as={Fragment}>
        <Dialog
          as="div"
          className={`relative ${isChangelogOpen ? 'z-[90]' : 'z-50'}`}
          onClose={resetToCurrent}
        >
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
                <DialogPanel data-testid="settings-modal" className="relative w-full max-w-4xl transform rounded-xl bg-base text-left align-middle shadow-xl transition-all overflow-hidden border border-offbase">
                  {/* Header */}
                  <div className="flex items-center justify-between px-5 py-3 border-b border-offbase">
                    <div className="flex items-baseline gap-4">
                      <DialogTitle as="h3" className="text-lg font-semibold leading-6 text-foreground">
                        Settings
                      </DialogTitle>
                      <Button
                        onClick={() => setIsChangelogOpen(true)}
                        className="text-sm font-medium leading-6 text-muted hover:text-accent transition-colors"
                      >
                        {displayVersion ? `v${displayVersion} · Changelog` : 'Changelog'}
                      </Button>
                    </div>
                    <div className="flex items-center">
                      {authEnabled && (
                        <Button
                          onClick={() => showPrivacyModal({ authEnabled })}
                          className="text-sm font-medium text-muted hover:text-accent transition-colors"
                        >
                          Privacy
                        </Button>
                      )}
                    </div>
                  </div>

                  {isChangelogOpen ? (
                    <SettingsChangelogPanel
                      appVersion={runtimeConfig.appVersion}
                      manifestUrl={runtimeConfig.changelogFeedUrl}
                      onClose={() => setIsChangelogOpen(false)}
                    />
                  ) : (
                    <>
                      {/* Mobile: 2x2 grid nav */}
                      <div className="grid grid-cols-2 gap-1 sm:hidden border-b border-offbase bg-background p-2">
                        {visibleSections.map((section) => {
                          const Icon = section.icon;
                          return (
                            <button
                              key={section.id}
                              onClick={() => setActiveSection(section.id)}
                              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                activeSection === section.id
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

                      <div className="flex flex-row h-[490px]">
                    {/* Desktop: vertical sidebar */}
                    <nav className="hidden sm:block w-44 shrink-0 border-r border-offbase bg-background p-2">
                      <div className="flex flex-col gap-1">
                        {visibleSections.map((section) => {
                          const Icon = section.icon;
                          const active = activeSection === section.id;
                          return (
                            <button
                              key={section.id}
                              onClick={() => setActiveSection(section.id)}
                              className={`w-full flex items-center gap-2.5 text-left px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                active
                                  ? 'bg-accent text-background'
                                  : 'text-foreground hover:bg-base hover:text-accent'
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
                    <div className={`flex-1 min-w-0 p-3 overflow-y-auto ${
                      activeSection === 'admin'
                        ? 'bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]'
                        : ''
                    }`}>
                      {/* API Section */}
                      {activeSection === 'api' && (
                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <label className={fieldLabelClass}>TTS Provider</label>
                            {ttsProviders.length === 0 ? (
                              <p className="text-xs text-amber-500">
                                User API keys are restricted and no shared provider is configured. Ask an admin to add one.
                              </p>
                            ) : (
                              <Listbox
                                value={selectedProviderOption!}
                                onChange={(provider) => {
                                  const defaults = resolveProviderDefaults({
                                    providerRef: provider.id,
                                    providerType: provider.providerType,
                                    sharedProviders,
                                  });
                                  setLocalProviderRef(provider.id);
                                  setLocalProviderType(defaults.providerType);
                                  setModelValue(defaults.defaultModel);
                                  setLocalTTSInstructions(defaults.defaultInstructions);
                                  if (provider.shared) {
                                    // Shared admin provider — credentials live on the server.
                                    setLocalApiKey('');
                                    setLocalBaseUrl('');
                                  } else if (isBuiltInTtsProviderId(provider.providerType)) {
                                    setLocalBaseUrl(defaultBaseUrlForProviderType(provider.providerType));
                                  }
                                  setCustomModelInput('');
                                }}
                              >
                                <ListboxButton className={listboxButtonClass}>
                                  <span className="block truncate">
                                    {selectedProviderOption?.name || 'Select Provider'}
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
                                  <ListboxOptions
                                    anchor="bottom start"
                                    className={listboxOptionsClass}
                                  >
                                    {ttsProviders.map((provider) => (
                                      <ListboxOption
                                        key={provider.id}
                                        className={({ active }) => listboxOptionClass(active)}
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
                            )}
                          </div>
                          {restrictUserApiKeys && (
                            <p className="text-xs text-muted">
                              This instance restricts user API keys. TTS runs through admin-configured shared providers only.
                            </p>
                          )}

                          {shouldShowBaseUrl && (
                            <div className="space-y-1.5">
                              <label className={fieldLabelClass}>
                                API Base URL
                                {localBaseUrl && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                              </label>
                              <Input
                                type="text"
                                value={localBaseUrl}
                                onChange={(e) => handleInputChange('baseUrl', e.target.value)}
                                placeholder="Using environment variable"
                                className={inputClass}
                              />
                            </div>
                          )}

                          {shouldShowApiKey && (
                            <div className="space-y-1.5">
                              <label className={fieldLabelClass}>
                                API Key
                                {localApiKey && <span className="ml-2 text-xs text-accent">(Overriding env)</span>}
                              </label>
                              <Input
                                type="password"
                                value={localApiKey}
                                onChange={(e) => handleInputChange('apiKey', e.target.value)}
                                placeholder="Using environment variable"
                                className={inputClass}
                              />
                            </div>
                          )}
                          {isSharedSelected && (
                            <p className="text-xs text-muted">
                              This is a shared provider configured by an admin. API key and base URL are managed server-side.
                            </p>
                          )}

                          <div className="space-y-1.5">
                            <label className={fieldLabelClass}>TTS Model</label>
                            {!showAllProviderModels && (
                              <p className="text-xs text-muted">
                                This instance restricts model selection to each provider&apos;s default model.
                              </p>
                            )}
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
                                <ListboxButton className={listboxButtonClass}>
                                  {selectedModel ? (
                                    <span className="block">
                                      <span className="block truncate">
                                        {selectedModel.name}
                                      </span>
                                      {selectedModelVersion && (
                                        <span className="block truncate text-xs text-muted">
                                          {selectedModelVersion}
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span className="block truncate">Select Model</span>
                                  )}
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
                                  <ListboxOptions
                                    anchor="bottom start"
                                    className={listboxOptionsClass}
                                  >
                                    {ttsModels.map((model) => (
                                      <ListboxOption
                                        key={model.id}
                                        className={({ active }) => listboxOptionClass(active)}
                                        value={model}
                                    >
                                      {({ selected }) => (
                                        <>
                                          <span className={`block ${selected ? 'font-medium' : 'font-normal'}`}>
                                            <span className="block truncate">{model.name}</span>
                                            {model.id.includes(':') && (
                                              <span className="block truncate text-xs text-muted">
                                                {model.id.slice(model.id.indexOf(':'))}
                                              </span>
                                            )}
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
                                  className={inputClass}
                                />
                              )}
                            </div>
                          </div>

                          {providerModelPolicy.supportsInstructions && (
                            <div className="space-y-1.5">
                              <label className={fieldLabelClass}>TTS Instructions</label>
                              <textarea
                                value={localTTSInstructions}
                                onChange={(e) => setLocalTTSInstructions(e.target.value)}
                                placeholder="Enter instructions for the TTS model"
                                className={`${inputClass} h-24 resize-none`}
                              />
                            </div>
                          )}

                          <div className="pt-4 flex justify-end gap-2">
                            <Button
                              type="button"
                              className={buttonClass({ variant: 'secondary', size: 'md' })}
                              onClick={async () => {
                                const defaults = resolveProviderDefaults({
                                  providerRef: runtimeConfig.defaultTtsProvider,
                                  sharedProviders,
                                });
                                setLocalApiKey('');
                                setLocalBaseUrl('');
                                setLocalProviderRef(defaults.providerRef);
                                setLocalProviderType(defaults.providerType);
                                setModelValue(defaults.defaultModel);
                                setCustomModelInput('');
                                setLocalTTSInstructions(defaults.defaultInstructions);
                              }}
                            >
                              Reset
                            </Button>
                            <Button
                              data-testid="settings-save-button"
                              type="button"
                              className={buttonClass({ variant: 'primary', size: 'md' })}
                              disabled={!canSubmit}
                              onClick={async () => {
                                const defaults = resolveProviderDefaults({
                                  providerRef: selectedProviderRef,
                                  providerType: selectedProviderType,
                                  sharedProviders,
                                });
                                await updateConfig({
                                  apiKey: restrictUserApiKeys ? '' : (localApiKey || ''),
                                  baseUrl: restrictUserApiKeys ? '' : (localBaseUrl || ''),
                                });
                                await updateConfigKey('providerRef', selectedProviderRef);
                                await updateConfigKey('providerType', selectedProviderType);
                                const finalModel = showAllProviderModels
                                  ? (selectedModelId === 'custom' ? customModelInput.trim() : modelValue)
                                  : defaults.defaultModel;
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
                                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 w-full text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
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
                                    className="text-xs font-medium w-14 shrink-0"
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

                          {/* Custom theme */}
                          <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-muted uppercase tracking-wide">Custom</label>
                            {(() => {
                              const colors = getThemeColors('custom');
                              const isActive = theme === 'custom';
                              return (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        setTheme('custom');
                                        setIsCustomExpanded(true);
                                      }}
                                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 flex-1 text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
                                        ${isActive
                                          ? 'border-accent'
                                          : 'border-offbase hover:border-muted'
                                        }`}
                                      style={{ backgroundColor: colors.base }}
                                    >
                                      {isActive ? (
                                        <CheckIcon className="h-3.5 w-3.5 shrink-0" style={{ color: colors.accent }} />
                                      ) : (
                                        <span className="w-3.5 shrink-0" />
                                      )}
                                      <span
                                        className="text-xs font-medium w-14 shrink-0"
                                        style={{ color: colors.foreground }}
                                      >
                                        Custom
                                      </span>
                                      <div className="flex gap-1 ml-auto">
                                        <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.background }} />
                                        <div className="w-4 h-4 rounded-full border border-offbase" style={{ backgroundColor: colors.offbase }} />
                                        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.accent }} />
                                        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.secondaryAccent }} />
                                        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: colors.muted }} />
                                      </div>
                                    </button>
                                    <button
                                      onClick={() => setIsCustomExpanded(!isCustomExpanded)}
                                      className="shrink-0 p-1.5 rounded-lg border border-offbase hover:border-muted transition-colors"
                                      style={{ color: colors.muted, backgroundColor: colors.base }}
                                      aria-label={isCustomExpanded ? 'Collapse color picker' : 'Expand color picker'}
                                    >
                                      <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${isCustomExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                      </svg>
                                    </button>
                                  </div>

                                  {isCustomExpanded && (
                                    <div
                                      className="rounded-lg border p-3 space-y-2"
                                      style={{
                                        backgroundColor: colors.background,
                                        borderColor: isActive ? colors.accent : colors.offbase,
                                      }}
                                    >
                                      <div className="flex flex-col gap-1">
                                        {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
                                          <div
                                            key={key}
                                            className="grid items-center rounded-md px-2 py-1"
                                            style={{
                                              backgroundColor: colors.base,
                                              gridTemplateColumns: '5rem 1fr auto',
                                              gap: '0.5rem',
                                            }}
                                          >
                                            <span
                                              className="text-xs font-medium truncate"
                                              style={{ color: colors.foreground }}
                                            >
                                              {label}
                                            </span>
                                            <span
                                              className="text-[10px] font-mono text-right"
                                              style={{ color: colors.muted }}
                                            >
                                              {customColors[key]}
                                            </span>
                                            <ColorPicker
                                              value={customColors[key]}
                                              field={key}
                                              label={label}
                                              onChange={(color) => {
                                                const updated = { ...customColors, [key]: color };
                                                setCustomColors(updated);
                                                applyCustomColors(updated);
                                              }}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>

                          {/* Light themes */}
                          <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-muted uppercase tracking-wide">Light</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              {lightThemes.map((t) => {
                                const colors = getThemeColors(t.id);
                                const isActive = theme === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
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
                                      className="text-xs font-medium w-14 shrink-0"
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
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              {darkThemes.map((t) => {
                                const colors = getThemeColors(t.id);
                                const isActive = theme === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-200 ease-in-out transform hover:scale-[1.02] border
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
                                      className="text-xs font-medium w-14 shrink-0"
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
                          <div className={sectionShellClass}>
                            <h4 className={sectionHeadingClass}>Server Library</h4>
                            <Button
                              onClick={handleImportLibrary}
                              disabled={isBusy}
                              className={buttonClass({ variant: 'outline', size: 'md' })}
                            >
                              {isImportingLibrary ? `Importing... ${Math.round(progress)}%` : 'Import from library'}
                            </Button>
                          </div>

                          <div className={sectionShellClass}>
                            <h4 className={sectionHeadingClass}>Cache & Data</h4>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                onClick={handleRefresh}
                                disabled={isBusy}
                                className={buttonClass({ variant: 'outline', size: 'md' })}
                              >
                                Refresh
                              </Button>
                              <Button
                                onClick={handleClearCache}
                                disabled={isBusy}
                                className={buttonClass({ variant: 'outline', size: 'md' })}
                              >
                                Clear cache
                              </Button>
                              {enableDestructiveDelete && !authEnabled && (
                                <Button
                                  onClick={() => setShowDeleteDocsConfirm(true)}
                                  disabled={isBusy}
                                  className={buttonClass({ variant: 'danger', size: 'md' })}
                                >
                                  Delete all data
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Admin Section */}
                      {activeSection === 'admin' && isAdmin && (
                        <div className="space-y-4">
                          <div
                            role="radiogroup"
                            aria-label="Admin tab"
                            className={`${segmentedGroupClass} grid-cols-2`}
                          >
                            {([
                              { id: 'providers', label: 'Shared providers' },
                              { id: 'features', label: 'Site features' },
                            ] as { id: AdminSubTab; label: string }[]).map((tab) => {
                              const active = adminSubTab === tab.id;
                              return (
                                <button
                                  key={tab.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  onClick={() => setAdminSubTab(tab.id)}
                                  className={segmentedButtonClass(active)}
                                >
                                  {tab.label}
                                </button>
                              );
                            })}
                          </div>
                          {adminSubTab === 'providers' && <AdminProvidersPanel />}
                          {adminSubTab === 'features' && <AdminFeaturesPanel />}
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
                                  className={buttonClass({ variant: 'outline', size: 'md', className: 'hover:scale-[1.04]' })}
                                >
                                  Disconnect account
                                </Button>

                                <div className="pt-4 mt-4 border-t border-offbase">
                                  <label className="block text-sm font-medium text-red-500 mb-2">Danger Zone</label>
                                  <Button
                                    onClick={() => setShowDeleteAccountConfirm(true)}
                                    className={buttonClass({ variant: 'danger', size: 'md' })}
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
                                    ? (runtimeConfig.enableUserSignups
                                      ? 'You are using an anonymous session. Sign up to save your progress permanently, your current data is automatically transferred.'
                                      : 'You are using an anonymous session. New account sign-ups are currently disabled by the site administrator.')
                                    : (runtimeConfig.enableUserSignups
                                      ? 'No active session. Please sign in or create an account.'
                                      : 'No active session. Please sign in.')}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  <Link href="/signin">
                                    <Button className={buttonClass({ variant: 'outline', size: 'md', className: 'hover:scale-[1.04]' })}>
                                      Connect
                                    </Button>
                                  </Link>
                                  {runtimeConfig.enableUserSignups && (
                                    <Link href="/signup">
                                      <Button className={buttonClass({ variant: 'primary', size: 'md', className: 'hover:scale-[1.04]' })}>
                                        Create account
                                      </Button>
                                    </Link>
                                  )}
                                  <Link href="/?redirect=false">
                                    <Button className={buttonClass({ variant: 'outline', size: 'md', className: 'hover:scale-[1.04]' })}>
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
                    </>
                  )}
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
        files={libraryDocuments}
        isLoading={isLibraryDocumentsLoading}
        errorMessage={libraryDocumentsErrorMessage}
      />
    </>
  );
}

function SettingsChangelogPanel({
  appVersion,
  manifestUrl,
  onClose,
}: {
  appVersion: string;
  manifestUrl: string;
  onClose: () => void;
}) {
  const [manifest, setManifest] = useState<ChangelogManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [bodies, setBodies] = useState<Record<string, ChangelogReleaseBody>>({});
  const normalizedAppVersion = normalizeVersion(appVersion || '');
  const isAbortError = (err: unknown): boolean => {
    return err instanceof DOMException
      ? err.name === 'AbortError'
      : !!(typeof err === 'object' && err && 'name' in err && (err as { name?: string }).name === 'AbortError');
  };

  useEffect(() => {
    const controller = new AbortController();
    async function loadManifest() {
      setLoading(true);
      setError(null);
      try {
        const entries = await fetchChangelogManifest(manifestUrl, controller.signal);
        setManifest(entries);
        const initialIndex = findCurrentVersionIndex(entries, normalizedAppVersion);
        if (initialIndex >= 0) {
          const entry = entries[initialIndex];
          setExpanded((prev) => ({ ...prev, [entry.tag_name]: true }));
        }
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Failed to load changelog');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadManifest();
    return () => controller.abort();
  }, [manifestUrl, normalizedAppVersion]);

  useEffect(() => {
    const controller = new AbortController();
    const tagsToLoad = manifest
      .filter((entry) => expanded[entry.tag_name] && !bodies[entry.tag_name])
      .map((entry) => entry.tag_name);
    if (tagsToLoad.length === 0) return () => controller.abort();

    async function loadBodies() {
      await Promise.all(tagsToLoad.map(async (tag) => {
        const entry = manifest.find((item) => item.tag_name === tag);
        if (!entry) return;
        try {
          const body = await fetchChangelogReleaseBody(manifestUrl, entry.body_path, controller.signal);
          setBodies((prev) => ({ ...prev, [tag]: body }));
        } catch (err) {
          if (isAbortError(err)) return;
          // Keep entry expanded; inline fallback appears below.
        }
      }));
    }
    void loadBodies();
    return () => controller.abort();
  }, [expanded, manifest, manifestUrl, bodies]);

  return (
    <div className="h-[490px] flex flex-col bg-base">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-offbase bg-background">
        <Button
          onClick={onClose}
          className="inline-flex items-center justify-center rounded-md text-muted hover:text-accent hover:bg-base transition-all duration-200 ease-in-out transform hover:scale-[1.01]"
          aria-label="Back to settings"
          title="Back"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </Button>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">Changelog</h4>
          <p className="text-xs text-muted truncate">
            {normalizedAppVersion
              ? `Current version: v${normalizedAppVersion}`
              : 'Release history from GitHub'}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && (
          <div className="py-3 text-sm text-muted">
            Loading changelog…
          </div>
        )}

        {!loading && error && (
          <div className="py-3 space-y-2 border-b border-offbase">
            <p className="text-sm text-foreground">Could not load changelog right now.</p>
            <p className="text-xs text-muted break-words">{error}</p>
            <a
              href="https://github.com/richardr1126/openreader/releases"
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs font-medium text-accent hover:underline transition-all duration-200 ease-in-out transform hover:scale-[1.02]"
            >
              Open GitHub Releases
            </a>
          </div>
        )}

        {!loading && !error && manifest.length === 0 && (
          <div className="py-3 text-sm text-muted">
            No releases found.
          </div>
        )}

        {!loading && !error && manifest.map((entry) => {
          const isCurrent = normalizedAppVersion && normalizeVersion(entry.tag_name) === normalizedAppVersion;
          const body = bodies[entry.tag_name];
          const isExpanded = !!expanded[entry.tag_name];
          const normalizedTag = normalizeVersion(entry.tag_name);
          const normalizedName = normalizeVersion(entry.name || '');
          const showName = Boolean(entry.name) && normalizedName !== normalizedTag;
          return (
            <div key={entry.tag_name} className="border-b border-offbase">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [entry.tag_name]: !isExpanded }))}
                className="w-full text-left py-2 flex items-center gap-2 hover:bg-base transition-all duration-200 ease-in-out transform hover:scale-[1.01]"
              >
                <ChevronRightIcon
                  className={`w-3.5 h-3.5 shrink-0 text-muted transition-transform ${
                    isExpanded ? 'rotate-90 text-foreground' : ''
                  }`}
                />
                <div className="min-w-0 flex items-center gap-2 text-sm w-full">
                  <span className="font-semibold text-foreground shrink-0">{entry.tag_name}</span>
                  {entry.prerelease && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-offbase text-muted shrink-0">
                      prerelease
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-offbase text-accent shrink-0">
                      current
                    </span>
                  )}
                  {showName && (
                    <span className="text-xs text-muted truncate">
                      {entry.name}
                    </span>
                  )}
                  <span className="text-[11px] text-muted shrink-0">
                    {new Date(entry.published_at).toLocaleDateString()}
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="pl-6 pr-1 pb-3 pt-1 space-y-2">
                  {body ? (
                    <div className="text-sm text-foreground leading-6 space-y-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:bg-offbase [&_code]:rounded [&_code]:px-1 [&_pre]:bg-offbase [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {body.body || '_No release notes provided._'}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-xs text-muted">Loading release notes…</p>
                  )}
                  <a
                    href={entry.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex text-xs font-medium text-accent hover:underline transition-all duration-200 ease-in-out transform hover:scale-[1.02]"
                  >
                    View on GitHub
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
