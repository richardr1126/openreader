'use client';

import { Fragment, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Transition, Listbox, Menu, MenuButton } from '@headlessui/react';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { DownloadIcon, CheckCircleIcon, XCircleIcon, ClockIcon, ChevronUpDownIcon, RefreshIcon, DotsVerticalIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';
import { Button, Card, IconButton, MenuActionItem, MenuItemsSurface, RangeInput, SharedListboxButton, SharedListboxOption, SharedListboxOptions } from '@/components/ui';
import { 
  getAudiobookStatus, 
  deleteAudiobookChapter, 
  deleteAudiobook, 
  downloadAudiobookChapter, 
  downloadAudiobook 
} from '@/lib/client/api/audiobooks';
import type { AudiobookGenerationSettings } from '@/types/client';
interface AudiobookExportModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  documentType: 'epub' | 'pdf' | 'html';
  documentId: string;
  onGenerateAudiobook: (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => Promise<string>; // Returns bookId
  onRegenerateChapter?: (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal
  ) => Promise<TTSAudiobookChapter>;
}

export function AudiobookExportModal({
  isOpen,
  setIsOpen,
  documentType,
  documentId,
  onGenerateAudiobook,
  onRegenerateChapter
}: AudiobookExportModalProps) {
  const { isLoading, isDBReady, providerRef, providerType, ttsModel, ttsInstructions, voice: configVoice, voiceSpeed, audioPlayerSpeed } = useConfig();
  const { availableVoices } = useTTS();
  const { progress, setProgress, estimatedTimeRemaining } = useTimeEstimation();
  const [isGenerating, setIsGenerating] = useState(false);
  const [chapters, setChapters] = useState<TTSAudiobookChapter[]>([]);
  const [bookId, setBookId] = useState<string | null>(null);
  const [isCombining, setIsCombining] = useState(false);
  const [isLoadingExisting, setIsLoadingExisting] = useState(false);
  const [isRefreshingChapters, setIsRefreshingChapters] = useState(false);
  const [currentChapter, setCurrentChapter] = useState<string>('');
  const [format, setFormat] = useState<TTSAudiobookFormat>('m4b');
  const [audiobookVoice, setAudiobookVoice] = useState<string>(configVoice || '');
  const [nativeSpeed, setNativeSpeed] = useState<number>(voiceSpeed);
  const [postSpeed, setPostSpeed] = useState<number>(audioPlayerSpeed);
  const [savedSettings, setSavedSettings] = useState<AudiobookGenerationSettings | null>(null);
  const [regeneratingChapter, setRegeneratingChapter] = useState<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [pendingDeleteChapter, setPendingDeleteChapter] = useState<TTSAudiobookChapter | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showRegenerateHint, setShowRegenerateHint] = useState(false);

  const formatSpeed = useCallback((speed: number) => {
    return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
  }, []);
  const providerModelPolicy = useMemo(
    () => resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel }),
    [providerRef, providerType, ttsModel],
  );
  const nativeSpeedSupported = providerModelPolicy.supportsNativeModelSpeed;
  const effectiveNativeSpeed = nativeSpeedSupported ? nativeSpeed : 1;

  const hasExistingAudiobook = Boolean(bookId) || chapters.length > 0;
  const isLegacyAudiobookMissingSettings = hasExistingAudiobook && savedSettings === null;

  useEffect(() => {
    // For new audiobooks (no saved settings/chapters), keep generation defaults aligned
    // with the current playback controls so users don't need a route remount.
    if (!isOpen) return;
    if (savedSettings) return;
    if (hasExistingAudiobook) return;

    setNativeSpeed(voiceSpeed);
    setPostSpeed(audioPlayerSpeed);
    setAudiobookVoice(configVoice || availableVoices[0] || '');
  }, [
    isOpen,
    savedSettings,
    hasExistingAudiobook,
    voiceSpeed,
    audioPlayerSpeed,
    configVoice,
    availableVoices,
  ]);

  useEffect(() => {
    if (savedSettings) return;
    if (audiobookVoice) return;
    if (availableVoices.length > 0) {
      setAudiobookVoice(availableVoices[0] || '');
    }
  }, [savedSettings, audiobookVoice, availableVoices]);

  const effectiveSettings: AudiobookGenerationSettings | null = useMemo(() => {
    if (savedSettings) return savedSettings;
    const nextVoice = audiobookVoice || configVoice || availableVoices[0] || '';
    if (!nextVoice) return null;
    return {
      providerRef,
      providerType,
      ttsModel,
      voice: nextVoice,
      nativeSpeed: effectiveNativeSpeed,
      postSpeed,
      format,
      ttsInstructions: providerModelPolicy.supportsInstructions ? ttsInstructions : undefined,
    };
  }, [savedSettings, audiobookVoice, configVoice, availableVoices, providerRef, providerType, ttsModel, ttsInstructions, effectiveNativeSpeed, postSpeed, format, providerModelPolicy.supportsInstructions]);

  const fetchExistingChapters = useCallback(async (soft: boolean = false) => {
    if (soft) {
      setIsRefreshingChapters(true);
    } else {
      setIsLoadingExisting(true);
    }
    try {
      const data = await getAudiobookStatus(documentId);
      if (data.exists) {
        setChapters(data.chapters || []);
        setBookId(data.bookId);
        if (data.chapters[0]?.format) {
          const detectedFormat = data.chapters[0].format as TTSAudiobookFormat;
          setFormat(detectedFormat);
        }
        if (data.settings) {
          setSavedSettings(data.settings);
          setAudiobookVoice(data.settings.voice);
          setNativeSpeed(data.settings.nativeSpeed);
          setPostSpeed(data.settings.postSpeed);
          setFormat(data.settings.format);
        } else {
          setSavedSettings(null);
        }
        if (data.hasComplete) {
          setProgress(100);
        }
      } else {
        // If nothing exists, clear chapters/bookId to reflect current state
        setChapters([]);
        setBookId(null);
        setSavedSettings(null);
      }
    } catch (error) {
      console.error('Error fetching existing chapters:', error);
    } finally {
      if (soft) {
        setIsRefreshingChapters(false);
      } else {
        setIsLoadingExisting(false);
      }
    }
  }, [documentId, setProgress]);

  // Fetch existing chapters when modal opens
  useEffect(() => {
    if (isOpen && documentId && !isGenerating) {
      fetchExistingChapters();
    }
  }, [isOpen, documentId, isGenerating, fetchExistingChapters]);

  const handleChapterComplete = useCallback((chapter: TTSAudiobookChapter) => {
    setChapters(prev => {
      const existing = prev.find(c => c.index === chapter.index);
      if (existing) {
        return prev.map(c => c.index === chapter.index ? chapter : c);
      }
      return [...prev, chapter].sort((a, b) => a.index - b.index);
    });
    setCurrentChapter(chapter.title);
  }, []);

  const handleStartGeneration = useCallback(async () => {
    if (!effectiveSettings) {
      setErrorMessage('No voice selected; please choose a voice before generating.');
      return;
    }
    setIsGenerating(true);
    setProgress(0);
    setCurrentChapter('');
    // Don't clear chapters if resuming
    if (!bookId) {
      setChapters([]);
      setBookId(null);
    }
    abortControllerRef.current = new AbortController();

    try {
      const generatedBookId = await onGenerateAudiobook(
        (progress) => setProgress(progress),
        abortControllerRef.current.signal,
        handleChapterComplete,
        effectiveSettings
      );
      setBookId(generatedBookId);
    } catch (error) {
      console.error('Error generating audiobook:', error);
      if (error instanceof Error && error.message.includes('cancelled')) {
        // Graceful cancellation - chapters are saved
        console.log('Audiobook generation cancelled gracefully');
      } else {
        // Show error to user for actual errors
        setErrorMessage(error instanceof Error ? error.message : 'Failed to generate audiobook. Please try again.');
      }
    } finally {
      setIsGenerating(false);
      setProgress(0);
      abortControllerRef.current = null;
      // Refresh chapters to show what was completed (soft refresh list only)
      if (bookId || documentId) {
        await fetchExistingChapters(true);
      }
    }
  }, [onGenerateAudiobook, handleChapterComplete, setProgress, bookId, documentId, fetchExistingChapters, effectiveSettings]);

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  // Cancel in-flight conversion if the page is being hidden or the component unmounts
  // (e.g., user navigates away from the document to the home screen).
  useEffect(() => {
    const onPageHide = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleRegenerateChapter = useCallback(async (chapter: TTSAudiobookChapter) => {
    if (!onRegenerateChapter || !bookId) return;
    if (!effectiveSettings) {
      setErrorMessage('No voice selected; please choose a voice before generating.');
      return;
    }

    if (!showRegenerateHint) {
      setShowRegenerateHint(true);
    }

    setRegeneratingChapter(chapter.index);
    setCurrentChapter(`Regenerating: ${chapter.title}`);
    abortControllerRef.current = new AbortController();

    try {
      // Update chapter status to generating
      setChapters(prev => {
        const exists = prev.some(c => c.index === chapter.index);
        if (exists) {
          return prev.map(c =>
            c.index === chapter.index
              ? { ...c, status: 'generating' as const }
              : c
          );
        }
        // If it's a missing placeholder, add it as generating
        return [...prev, { ...chapter, status: 'generating' as const }].sort((a, b) => a.index - b.index);
      });

      const regeneratedChapter = await onRegenerateChapter(
        chapter.index,
        bookId,
        effectiveSettings,
        abortControllerRef.current.signal
      );

      // Update chapter with new data
      setChapters(prev => prev.map(c =>
        c.index === chapter.index
          ? regeneratedChapter
          : c
      ));

    } catch (error) {
      console.error('Error regenerating chapter:', error);
      if (error instanceof Error && error.message.includes('cancelled')) {
        console.log('Chapter regeneration cancelled');
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to regenerate chapter. Please try again.');
        // Mark as error
        setChapters(prev => prev.map(c =>
          c.index === chapter.index
            ? { ...c, status: 'error' as const }
            : c
        ));
      }
    } finally {
      setRegeneratingChapter(null);
      setCurrentChapter('');
      setProgress(0);
      abortControllerRef.current = null;
      // Refresh chapters to get updated data (soft refresh list only)
      await fetchExistingChapters(true);
    }
  }, [onRegenerateChapter, bookId, setProgress, fetchExistingChapters, showRegenerateHint, effectiveSettings]);

  const performDeleteChapter = useCallback(async () => {
    if (!bookId || !pendingDeleteChapter) return;
    try {
      await deleteAudiobookChapter(bookId, pendingDeleteChapter.index);
      setChapters(prev => prev.filter(c => c.index !== pendingDeleteChapter.index));
      await fetchExistingChapters(true);
    } catch (error) {
      console.error('Error deleting chapter:', error);
      setErrorMessage('Failed to delete chapter. Please try again.');
    } finally {
      setPendingDeleteChapter(null);
    }
  }, [bookId, pendingDeleteChapter, fetchExistingChapters]);

  const performResetAll = useCallback(async () => {
    const targetBookId = bookId || documentId;
    if (!targetBookId) return;
    try {
      await deleteAudiobook(targetBookId);
      setChapters([]);
      setBookId(null);
      setProgress(0);
    } catch (error) {
      console.error('Error resetting audiobook chapters:', error);
      setErrorMessage('Failed to reset chapters. Please try again.');
    } finally {
      setShowResetConfirm(false);
      await fetchExistingChapters(true);
    }
  }, [bookId, documentId, setProgress, fetchExistingChapters]);

  const handleDownloadChapter = useCallback(async (chapter: TTSAudiobookChapter) => {
    if (!chapter.bookId) return;

    try {
      const blob = await downloadAudiobookChapter(chapter.bookId, chapter.index);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Use the chapter's stored format directly - it knows what it actually is
      const ext = chapter.format || 'm4b';
      a.download = `${chapter.title}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading chapter:', error);
      setErrorMessage('Failed to download chapter. Please try again.');
    }
  }, []);

  const handleDownloadComplete = useCallback(async () => {
    if (!bookId) return;

    setIsCombining(true);
    try {
      const response = await downloadAudiobook(bookId, format);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const mimeType = format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
      const blob = new Blob(chunks as BlobPart[], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audiobook.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading complete audiobook:', error);
      setErrorMessage('Failed to download audiobook. Please try again.');
    } finally {
      setIsCombining(false);
    }
  }, [bookId, format]);


  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Compute display list including gaps before the highest existing index
  const maxIndex = chapters.length > 0 ? Math.max(...chapters.map(c => c.index)) : -1;
  const displayChapters: TTSAudiobookChapter[] =
    maxIndex >= 0
      ? Array.from({ length: maxIndex + 1 }, (_, i) => {
        const existing = chapters.find(c => c.index === i);
        if (existing) return existing;
        return {
          index: i,
          title: documentType === 'pdf' ? `Page ${i + 1}` : `Chapter ${i + 1}`,
          status: 'pending',
          bookId: bookId || undefined,
          format
        };
      })
      : [];

  // Determine if we should show the Resume and Reset buttons
  const hasAnyChapters = chapters.length > 0;
  const showResumeButton = !isGenerating && !regeneratingChapter && hasAnyChapters;
  const showResetButton = !isGenerating && !regeneratingChapter && hasAnyChapters;
  const settingsLocked = savedSettings !== null;
  const canGenerate = effectiveSettings !== null;

  // Do not render until storage/config is initialized
  if (isLoading || !isDBReady) {
    return null;
  }

  return (
    <>
      <ProgressPopup
        isOpen={isGenerating && !isOpen}
        progress={progress}
        estimatedTimeRemaining={estimatedTimeRemaining || undefined}
        onCancel={handleCancel}
        cancelText="Cancel"
        operationType="audiobook"
        onClick={() => setIsOpen(true)}
        currentChapter={currentChapter}
        totalChapters={documentType === 'epub' ? undefined : undefined}
        completedChapters={chapters.filter(c => c.status === 'completed').length}
      />

      <ReaderSidebarShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Export audiobook"
        title="Export Audiobook"
        subtitle="Only leaving the document cancels generation."
      >
                {isLoadingExisting ? (
                  <AudiobookSettingsSkeleton />
                ) : (
                  <>
			                      <div className="space-y-4">
			                        {!isGenerating && (
			                          <div className="w-full rounded-lg border border-line bg-background">
			                            {/* Header */}
			                            <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft bg-surface rounded-t-xl">
			                              <h4 className="text-sm font-medium text-foreground tracking-tight">Generation settings</h4>
			                              {settingsLocked && (
			                                <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-soft uppercase tracking-wider">
			                                  <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" /></svg>
			                                  Locked
			                                </span>
			                              )}
			                            </div>

			                            <div className="p-4">
			                              {isLegacyAudiobookMissingSettings && (
			                                <div className="mb-4 rounded-lg border border-accent-line bg-accent-wash p-3 text-xs text-foreground">
			                                  <div className="font-medium">Saved generation settings not found</div>
			                                  <div className="mt-1 text-soft">
			                                    This audiobook was likely created before v1 metadata was introduced, so OpenReader can&apos;t know
			                                    which voice/speeds/format were used. Consider resetting this audiobook to regenerate it with
			                                    v1 metadata (so settings are saved for resumes across devices).
			                                  </div>
			                                </div>
			                              )}

			                              {settingsLocked && savedSettings ? (
			                                <div className="space-y-3">
			                                  <div className="grid grid-cols-2 gap-3">
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Voice</div>
			                                      <div className="text-sm font-medium text-foreground truncate">{savedSettings.voice}</div>
			                                    </Card>
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Format</div>
			                                      <div className="text-sm font-medium text-foreground">{savedSettings.format.toUpperCase()}</div>
			                                    </Card>
			                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <Card className="p-3">
                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Native speed</div>
                                      <div className="text-sm font-medium text-foreground">
                                        {resolveTtsProviderModelPolicy({
                                          providerRef: savedSettings.providerRef,
                                          providerType: savedSettings.providerType,
                                          model: savedSettings.ttsModel,
                                        }).supportsNativeModelSpeed
                                          ? `${formatSpeed(savedSettings.nativeSpeed)}x`
                                          : 'Not supported'}
                                      </div>
                                    </Card>
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Post speed</div>
			                                      <div className="text-sm font-medium text-foreground">{formatSpeed(savedSettings.postSpeed)}x</div>
			                                    </Card>
			                                  </div>
			                                  <p className="text-xs text-soft">
			                                    Reset the audiobook to change generation settings.
			                                  </p>
			                                </div>
			                              ) : (
			                                <div className="space-y-4">
			                                  {/* Voice & Format row */}
			                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
			                                    <div className="space-y-1.5">
			                                      <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Voice</label>
			                                      <VoicesControlBase
			                                        availableVoices={availableVoices}
			                                        voice={audiobookVoice}
			                                        onChangeVoice={setAudiobookVoice}
			                                        providerType={providerType}
			                                        ttsModel={ttsModel}
			                                        dropdownDirection="down"
			                                        variant="field"
			                                      />
			                                    </div>

			                                    <div className="space-y-1.5">
			                                      <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Format</label>
			                                      {chapters.length === 0 ? (
			                                        <Listbox
			                                          value={format}
			                                          onChange={(newFormat) => setFormat(newFormat)}
			                                          disabled={chapters.length > 0 || settingsLocked}
			                                        >
			                                          <div className="relative">
			                                            <SharedListboxButton className="bg-surface">
			                                              <span className="block truncate text-sm font-medium">{format.toUpperCase()}</span>
			                                              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
			                                                <ChevronUpDownIcon className="h-4 w-4 text-soft" />
			                                              </span>
			                                            </SharedListboxButton>
			                                            <Transition
			                                              as={Fragment}
			                                              leave="transition ease-standard duration-fast"
			                                              leaveFrom="opacity-100"
			                                              leaveTo="opacity-0"
			                                            >
			                                              <SharedListboxOptions className="absolute left-0 mt-1 w-full">
			                                                <SharedListboxOption
			                                                  value="m4b"
			                                                  inset="none"
			                                                  itemClassName="py-2"
			                                                >
			                                                  {({ selected }) => (
			                                                    <span className={`block truncate text-sm ${selected ? 'font-medium' : 'font-normal'}`}>
			                                                      M4B
			                                                    </span>
			                                                  )}
			                                                </SharedListboxOption>
			                                                <SharedListboxOption
			                                                  value="mp3"
			                                                  inset="none"
			                                                  itemClassName="py-2"
			                                                >
			                                                  {({ selected }) => (
			                                                    <span className={`block truncate text-sm ${selected ? 'font-medium' : 'font-normal'}`}>
			                                                      MP3
			                                                    </span>
			                                                  )}
			                                                </SharedListboxOption>
			                                              </SharedListboxOptions>
			                                            </Transition>
			                                          </div>
			                                        </Listbox>
			                                      ) : (
			                                        <div className="text-sm font-medium text-foreground py-1.5 pl-3">{format.toUpperCase()}</div>
			                                      )}
			                                    </div>
			                                  </div>

                                  {/* Speed controls */}
                                  <Card className="p-3 space-y-3">
                                    {!nativeSpeedSupported && (
                                      <div className="rounded-md border border-line bg-background px-2 py-1.5 text-[11px] text-soft">
                                        Native model speed is not available for this model.
                                      </div>
                                    )}

                                    {nativeSpeedSupported && (
                                      <>
                                        <div className="space-y-2">
                                          <div className="flex items-center justify-between">
                                            <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Native model speed</label>
                                            <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(nativeSpeed)}x</span>
                                          </div>
                                          <RangeInput
                                            min="0.5"
                                            max="3"
                                            step="0.1"
                                            value={nativeSpeed}
                                            onChange={(e) => setNativeSpeed(parseFloat(e.target.value))}
                                          />
                                          <div className="flex justify-between text-[10px] text-soft">
                                            <span>0.5x</span>
                                            <span>3x</span>
                                          </div>
                                        </div>

                                        <div className="border-t border-line-soft" />
                                      </>
                                    )}

			                                    <div className="space-y-2">
			                                      <div className="flex items-center justify-between">
			                                        <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Post-generation speed</label>
			                                        <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(postSpeed)}x</span>
			                                      </div>
			                                      <RangeInput
			                                        min="0.5"
			                                        max="3"
			                                        step="0.1"
			                                        value={postSpeed}
			                                        onChange={(e) => setPostSpeed(parseFloat(e.target.value))}
			                                      />
			                                      <div className="flex justify-between text-[10px] text-soft">
			                                        <span>0.5x</span>
			                                        <span>3x</span>
			                                      </div>
			                                    </div>
			                                  </Card>
			                                </div>
			                              )}

			                              {/* Action buttons */}
			                              <div className="mt-4 flex items-center gap-2">
			                                {chapters.length === 0 && (
			                                  <Button
			                                    onClick={handleStartGeneration}
			                                    disabled={!canGenerate}
			                                    variant="primary"
			                                    size="md"
			                                    className="flex-1"
			                                  >
			                                    Start Generation
			                                  </Button>
			                                )}
			                                {showResumeButton && (
			                                  <Button
			                                    onClick={handleStartGeneration}
			                                    disabled={!canGenerate}
			                                    variant="primary"
			                                    size="md"
			                                    className="flex-1"
			                                  >
			                                    Resume
			                                  </Button>
			                                )}
			                                {showResetButton && (
			                                  <Button
			                                    onClick={() => setShowResetConfirm(true)}
			                                    disabled={isGenerating}
			                                    variant="danger"
			                                    size="md"
			                                    title="Delete all generated chapters/pages for this document"
			                                  >
			                                    Reset
			                                  </Button>
			                                )}
			                              </div>
			                            </div>
			                          </div>
			                        )}
                        {showRegenerateHint && (
                          <div className="flex items-start justify-between bg-surface-sunken border border-line rounded-md px-3 py-2 text-xs sm:text-sm">
                            <p className="text-xs sm:text-sm text-foreground">
                              TTS audio for this chapter may be cached
                              <br />
                              Change the TTS playback options or restart the server to force uncached regeneration
                            </p>
                            <IconButton
                              onClick={() => setShowRegenerateHint(false)}
                              className="ml-3"
                              aria-label="Dismiss regenerate hint"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </IconButton>
                          </div>
                        )}
                        {/* Progress Info */}
                        {isGenerating && (
                          <ProgressCard
                            progress={progress}
                            estimatedTimeRemaining={estimatedTimeRemaining || undefined}
                            onCancel={handleCancel}
                            operationType="audiobook"
                            currentChapter={currentChapter}
                            completedChapters={chapters.filter(c => c.status === 'completed').length}
                            cancelText="Cancel"
                          />
                        )}

                        {chapters.length > 0 && (
                          <>
                            <div
                              className={`w-full space-y-2 max-h-96 overflow-y-auto ${isRefreshingChapters ? 'opacity-70 transition-opacity' : ''}`}
                              aria-busy={isRefreshingChapters}
                            >
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-medium text-foreground">Chapters</h4>
                                {isRefreshingChapters && <ClockIcon className="h-4 w-4 text-soft animate-spin" />}
                              </div>
                              {displayChapters.map((chapter) => (
                                <div
                                  key={chapter.index}
                                  className={`flex items-center justify-between px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg bg-surface-sunken ${(regeneratingChapter === chapter.index || chapter.status === 'generating') ? 'prism-outline' : ''}`}
                                >
                                  <div className="flex items-center space-x-3 flex-1">
                                    {chapter.status === 'completed' ? (
                                      <CheckCircleIcon className="h-5 w-5 text-accent" />
                                    ) : onRegenerateChapter ? (
                                      <IconButton
                                        onClick={() => handleRegenerateChapter(chapter)}
                                        disabled={regeneratingChapter !== null || chapter.status === 'generating' || isGenerating}
                                        tone="ghost"
                                        size="sm"
                                        className="rounded-full bg-surface-sunken text-accent"
                                        title={chapter.status === 'generating' ? 'Generating...' : 'Regenerate this chapter'}
                                      >
                                        <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index || chapter.status === 'generating' ? 'animate-spin' : ''}`} />
                                      </IconButton>
                                    ) : (
                                      <ClockIcon className="h-5 w-5 text-soft" />
                                    )}
                                    <div className="flex flex-row flex-wrap items-center gap-1">
                                      <p className="text-sm font-medium text-foreground">
                                        {chapter.title}
                                      </p>
                                      <p>•</p>
                                      <p className="text-xs text-soft mt-0.5">
                                        {chapter.status !== 'completed' && <span className="text-warning">Missing • </span>}{formatDuration(chapter.duration)}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center">
                                    {((onRegenerateChapter && !isGenerating) || chapter.status === 'completed') && (
                                      <Menu as="div" className="relative inline-block text-left">
                                        <MenuButton
                                          as={IconButton}
                                          size="sm"
                                          title="Chapter actions"
                                        >
                                          <DotsVerticalIcon className="h-5 w-5" />
                                        </MenuButton>
                                        <Transition
                                          as={Fragment}
                                          enter="transition ease-standard duration-fast"
                                          enterFrom="transform opacity-0 scale-95"
                                          enterTo="transform opacity-100 scale-100"
                                          leave="transition ease-standard duration-fast"
                                          leaveFrom="transform opacity-100 scale-100"
                                          leaveTo="transform opacity-0 scale-95"
                                        >
                                          <MenuItemsSurface
                                            anchor={{ to: 'bottom end', gap: '8px', padding: '12px' }}
                                            portal
                                            className="z-[70] w-44 origin-top-right bg-background focus:outline-none"
                                          >
                                            {chapter.status === 'completed' && (
                                              <>
                                                <MenuActionItem
                                                  tone="danger"
                                                  onClick={() => setPendingDeleteChapter(chapter)}
                                                  title="Delete this chapter"
                                                >
                                                  <XCircleIcon className="h-4 w-4" />
                                                  <span>Delete</span>
                                                </MenuActionItem>
                                                <MenuActionItem onClick={() => handleDownloadChapter(chapter)}>
                                                  <DownloadIcon className="h-4 w-4" />
                                                  <span>Download</span>
                                                </MenuActionItem>
                                              </>
                                            )}
                                            {regeneratingChapter === chapter.index && (
                                              <MenuActionItem
                                                tone="danger"
                                                onClick={handleCancel}
                                                title="Cancel this chapter regeneration"
                                              >
                                                <XCircleIcon className="h-4 w-4" />
                                                <span>Cancel</span>
                                              </MenuActionItem>
                                            )}
                                            {onRegenerateChapter && !isGenerating && (
                                              <MenuActionItem
                                                disabled={regeneratingChapter !== null}
                                                onClick={() => handleRegenerateChapter(chapter)}
                                                title="Regenerate this chapter"
                                              >
                                                <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index ? 'animate-spin' : ''}`} />
                                                <span>{regeneratingChapter === chapter.index ? 'Regenerating...' : 'Regenerate'}</span>
                                              </MenuActionItem>
                                            )}
                                          </MenuItemsSurface>
                                          {/* end of menu items */}
                                        </Transition>
                                      </Menu>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {bookId && !isGenerating && (
                              <div className="pt-4 border-t border-line-soft">
                                <Button
                                  onClick={handleDownloadComplete}
                                  disabled={isCombining}
                                  variant="primary"
                                  size="md"
                                  className="w-full space-x-2"
                                >
                                  <DownloadIcon className="h-5 w-5" />
                                  <span>{isCombining ? 'Combining chapters...' : `Full Download (${format.toUpperCase()})`}</span>
                                </Button>
                              </div>
                            )}
                          </>
                        )}

                        {chapters.length === 0 && !isGenerating && !isLoadingExisting && (
                          <div className="text-center">
                            <p className="text-sm text-soft">
                              Audiobook settings are fixed after generation. Chapters will appear here as they are ready.
                            </p>
                          </div>
                        )}
                      </div>

                    </>
                  )}
      </ReaderSidebarShell>
      {/* Confirm delete chapter */}
      <ConfirmDialog
        isOpen={pendingDeleteChapter !== null}
        onClose={() => setPendingDeleteChapter(null)}
        onConfirm={performDeleteChapter}
        title="Delete Chapter"
        message={pendingDeleteChapter ? `Delete "${pendingDeleteChapter.title}"? This will remove the audio and metadata for this chapter.` : ''}
        confirmText="Delete"
        cancelText="Cancel"
        isDangerous
      />
      {/* Confirm reset all */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={performResetAll}
        title="Reset Audiobook"
        message="Reset audiobook? This deletes all generated chapters/pages and any combined files. This cannot be undone."
        confirmText="Reset"
        cancelText="Cancel"
        isDangerous
      />
      {/* Error dialog replacing alerts */}
      <ConfirmDialog
        isOpen={errorMessage !== null}
        onClose={() => setErrorMessage(null)}
        onConfirm={() => setErrorMessage(null)}
        title="Operation Failed"
        message={errorMessage || ''}
        confirmText="Close"
        cancelText=""
        isDangerous={false}
      />
    </>
  );
}

function AudiobookSettingsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-label="Loading audiobook settings" aria-busy="true">
      <div className="w-full rounded-lg border border-line bg-background overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft bg-surface">
          <div className="h-4 w-40 rounded bg-surface-sunken" />
          <div className="h-5 w-14 rounded bg-surface-sunken" />
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="h-3 w-16 rounded bg-surface-sunken" />
              <div className="h-9 w-full rounded-md bg-surface-sunken" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-16 rounded bg-surface-sunken" />
              <div className="h-9 w-full rounded-md bg-surface-sunken" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="h-3 w-24 rounded bg-surface-sunken" />
              <div className="h-2 w-full rounded bg-surface-sunken" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-20 rounded bg-surface-sunken" />
              <div className="h-2 w-full rounded bg-surface-sunken" />
            </div>
          </div>
          <div className="h-9 w-full rounded-md bg-surface-sunken" />
        </div>
      </div>

      <div className="w-full rounded-lg border border-line bg-background overflow-hidden">
        <div className="px-4 py-3 border-b border-line-soft bg-surface">
          <div className="h-4 w-28 rounded bg-surface-sunken" />
        </div>
        <div className="p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-16 rounded-lg border border-line bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}
