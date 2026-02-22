'use client';

import { Fragment, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Dialog, DialogPanel, Transition, TransitionChild, Button, Listbox, ListboxButton, ListboxOptions, ListboxOption, Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { DownloadIcon, CheckCircleIcon, XCircleIcon, ClockIcon, ChevronUpDownIcon, RefreshIcon, DotsVerticalIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingSpinner } from '@/components/Spinner';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';
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
  documentType: 'epub' | 'pdf';
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
  const { isLoading, isDBReady, ttsProvider, ttsModel, voice: configVoice, voiceSpeed, audioPlayerSpeed } = useConfig();
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
      ttsProvider,
      ttsModel,
      voice: nextVoice,
      nativeSpeed,
      postSpeed,
      format,
    };
  }, [savedSettings, audiobookVoice, configVoice, availableVoices, ttsProvider, ttsModel, nativeSpeed, postSpeed, format]);

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

      <Transition appear show={isOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={() => setIsOpen(false)}>
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
                <DialogPanel className="w-full max-w-2xl transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                  {isLoadingExisting ? (
                    <div className="flex justify-center py-8">
                      <LoadingSpinner />
                    </div>
                  ) : (
	                    <>
			                      <div className="space-y-4">
			                        <div className="flex justify-between items-start gap-3">
			                          <h3 className="text-lg font-medium text-foreground">Export Audiobook</h3>
			                        </div>
			                        {!isGenerating && (
			                          <div className="flex justify-center">
			                            <div className="w-full rounded-xl border border-offbase bg-background p-4">
			                              <div className="flex items-start justify-between gap-3">
			                                <div>
			                                  <h4 className="text-sm font-medium text-foreground">Generation settings</h4>
			                                  <p className="text-xs text-muted mt-0.5">
			                                    These settings are saved per audiobook for consistent resumes across devices.
			                                  </p>
			                                </div>
				                                {settingsLocked && (
				                                  <span className="inline-flex items-center rounded-full bg-offbase px-2 py-0.5 text-xs text-muted">
				                                    Locked
				                                  </span>
				                                )}
				                              </div>

				                              {isLegacyAudiobookMissingSettings && (
				                                <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-foreground">
				                                  <div className="font-medium">Saved generation settings not found</div>
				                                  <div className="mt-1 text-muted">
				                                    This audiobook was likely created before v1 metadata was introduced, so OpenReader can’t know
				                                    which voice/speeds/format were used. Consider resetting this audiobook to regenerate it with
				                                    v1 metadata (so settings are saved for resumes across devices).
				                                  </div>
				                                </div>
				                              )}

				                              {settingsLocked && savedSettings ? (
				                                <div className="mt-3 text-sm">
				                                  <div className="text-muted">
				                                    Voice: <span className="text-foreground">{savedSettings.voice}</span>
			                                  </div>
			                                  <div className="text-muted">
			                                    Native speed: <span className="text-foreground">{formatSpeed(savedSettings.nativeSpeed)}x</span>
			                                  </div>
			                                  <div className="text-muted">
			                                    Post speed: <span className="text-foreground">{formatSpeed(savedSettings.postSpeed)}x</span>
			                                  </div>
			                                  <div className="text-muted">
			                                    Format: <span className="text-foreground">{savedSettings.format.toUpperCase()}</span>
			                                  </div>
			                                  <p className="text-xs text-muted mt-2">
			                                    Reset the audiobook to change generation settings.
			                                  </p>
			                                </div>
			                              ) : (
			                                <div className="mt-3 space-y-4">
			                                  <div className="space-y-1">
			                                    <div className="text-xs font-medium text-foreground">Voice</div>
			                                    <VoicesControlBase
			                                      availableVoices={availableVoices}
			                                      voice={audiobookVoice}
			                                      onChangeVoice={setAudiobookVoice}
			                                      ttsProvider={ttsProvider}
			                                      ttsModel={ttsModel}
			                                    />
			                                  </div>

			                                  <div className="space-y-1">
			                                    <div className="text-xs font-medium text-foreground">Output format</div>
			                                    {chapters.length === 0 ? (
			                                      <Listbox
			                                        value={format}
			                                        onChange={(newFormat) => setFormat(newFormat)}
			                                        disabled={chapters.length > 0 || settingsLocked}
			                                      >
			                                        <div className="relative inline-block">
			                                          <ListboxButton className="relative cursor-pointer rounded-lg bg-base py-1.5 pl-3 pr-10 text-left text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.01] hover:text-accent min-w-[120px]">
			                                            <span className="block truncate text-sm font-medium">{format.toUpperCase()}</span>
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
			                                            <ListboxOptions className="absolute left-0 mt-1 max-h-60 w-full overflow-auto rounded-md bg-base py-1 shadow-lg ring-1 ring-black/5 focus:outline-none z-10">
			                                              <ListboxOption
			                                                value="m4b"
			                                                className={({ active }) =>
			                                                  `relative cursor-pointer select-none py-2 pl-3 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'
			                                                  }`
			                                                }
			                                              >
			                                                {({ selected }) => (
			                                                  <span className={`block truncate text-sm ${selected ? 'font-medium' : 'font-normal'}`}>
			                                                    M4B
			                                                  </span>
			                                                )}
			                                              </ListboxOption>
			                                              <ListboxOption
			                                                value="mp3"
			                                                className={({ active }) =>
			                                                  `relative cursor-pointer select-none py-2 pl-3 pr-4 ${active ? 'bg-offbase text-accent' : 'text-foreground'
			                                                  }`
			                                                }
			                                              >
			                                                {({ selected }) => (
			                                                  <span className={`block truncate text-sm ${selected ? 'font-medium' : 'font-normal'}`}>
			                                                    MP3
			                                                  </span>
			                                                )}
			                                              </ListboxOption>
			                                            </ListboxOptions>
			                                          </Transition>
			                                        </div>
			                                      </Listbox>
			                                    ) : (
			                                      <div className="text-sm text-foreground">{format.toUpperCase()}</div>
			                                    )}
			                                  </div>

			                                  <div className="space-y-1">
			                                    <div className="flex items-center">
			                                      <div className="text-xs font-medium text-foreground mr-1">Native model speed</div>
			                                      <div className="text-xs text-muted">• {formatSpeed(nativeSpeed)}x</div>
			                                    </div>
			                                    <input
			                                      type="range"
			                                      min="0.5"
			                                      max="3"
			                                      step="0.1"
			                                      value={nativeSpeed}
			                                      onChange={(e) => setNativeSpeed(parseFloat(e.target.value))}
			                                      className="w-full max-w-xs bg-offbase rounded-lg appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-lg [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent"
			                                    />
			                                  </div>

			                                  <div className="space-y-1">
			                                    <div className="flex items-center">
			                                      <div className="text-xs font-medium text-foreground mr-1">Post-generation speed</div>
			                                      <div className="text-xs text-muted">• {formatSpeed(postSpeed)}x</div>
			                                    </div>
			                                    <input
			                                      type="range"
			                                      min="0.5"
			                                      max="3"
			                                      step="0.1"
			                                      value={postSpeed}
			                                      onChange={(e) => setPostSpeed(parseFloat(e.target.value))}
			                                      className="w-full max-w-xs bg-offbase rounded-lg appearance-none cursor-pointer accent-accent [&::-webkit-slider-runnable-track]:bg-offbase [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-moz-range-track]:bg-offbase [&::-moz-range-track]:rounded-lg [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent"
			                                    />
			                                  </div>
			                                </div>
			                              )}

			                              <div className="mt-4 space-y-2">
			                                {chapters.length === 0 && (
			                                  <Button
			                                    onClick={handleStartGeneration}
			                                    disabled={!canGenerate}
			                                    className="w-full inline-flex justify-center rounded-lg bg-accent px-3 py-2 text-sm
			                                            font-medium text-background hover:bg-secondary-accent focus:outline-none
			                                            focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
			                                            transform transition-transform duration-200 ease-in-out hover:scale-[1.01] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
			                                  >
			                                    Start Generation
			                                  </Button>
			                                )}
			                                {showResumeButton && (
			                                  <Button
			                                    onClick={handleStartGeneration}
			                                    disabled={!canGenerate}
			                                    className="w-full inline-flex justify-center rounded-lg bg-accent px-3 py-2 text-sm
			                                            font-medium text-background hover:bg-secondary-accent focus:outline-none
			                                            focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
			                                            transform transition-transform duration-200 ease-in-out hover:scale-[1.01] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
			                                  >
			                                    Resume
			                                  </Button>
			                                )}
			                                {showResetButton && (
			                                  <Button
			                                    onClick={() => setShowResetConfirm(true)}
			                                    disabled={isGenerating}
			                                    className="w-full justify-center rounded-lg bg-red-500 px-3 py-2 text-sm 
			                                           font-medium text-background hover:bg-red-500/90 focus:outline-none 
			                                           focus-visible:ring-2 focus-visible:bg-red-500 focus-visible:ring-offset-2
			                                         transform transition-transform duration-200 ease-in-out hover:scale-[1.01]"
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
                          <div className="flex items-start justify-between bg-offbase border border-offbase rounded-md px-3 py-2 text-xs sm:text-sm">
                            <p className="text-xs sm:text-sm text-foreground">
                              TTS audio for this chapter may be cached
                              <br />
                              Change the TTS playback options or restart the server to force uncached regeneration
                            </p>
                            <Button
                              onClick={() => setShowRegenerateHint(false)}
                              className="ml-3 p-1 rounded-md hover:bg-base hover:text-accent transition-colors"
                              aria-label="Dismiss regenerate hint"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </Button>
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
                              className={`space-y-2 max-h-96 overflow-scroll pr-1 ${isRefreshingChapters ? 'opacity-70 transition-opacity' : ''}`}
                              aria-busy={isRefreshingChapters}
                            >
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-medium text-foreground">Chapters</h4>
                                {isRefreshingChapters && <ClockIcon className="h-4 w-4 text-muted animate-spin" />}
                              </div>
                              {displayChapters.map((chapter) => (
                                <div
                                  key={chapter.index}
                                  className={`flex items-center justify-between px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg bg-offbase ${(regeneratingChapter === chapter.index || chapter.status === 'generating') ? 'prism-outline' : ''}`}
                                >
                                  <div className="flex items-center space-x-3 flex-1">
                                    {chapter.status === 'completed' ? (
                                      <CheckCircleIcon className="h-5 w-5 text-accent" />
                                    ) : onRegenerateChapter ? (
                                      <Button
                                        onClick={() => handleRegenerateChapter(chapter)}
                                        disabled={regeneratingChapter !== null || chapter.status === 'generating' || isGenerating}
                                        className="inline-flex items-center justify-center rounded-full bg-offbase text-accent hover:bg-accent/20 p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.04] disabled:opacity-50 disabled:cursor-not-allowed"
                                        title={chapter.status === 'generating' ? 'Generating...' : 'Regenerate this chapter'}
                                      >
                                        <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index || chapter.status === 'generating' ? 'animate-spin' : ''}`} />
                                      </Button>
                                    ) : (
                                      <ClockIcon className="h-5 w-5 text-muted" />
                                    )}
                                    <div className="flex flex-row flex-wrap items-center gap-1">
                                      <p className="text-sm font-medium text-foreground">
                                        {chapter.title}
                                      </p>
                                      <p>•</p>
                                      <p className="text-xs text-muted mt-0.5">
                                        {chapter.status !== 'completed' && <span className="text-warning">Missing • </span>}{formatDuration(chapter.duration)}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center">
                                    {((onRegenerateChapter && !isGenerating) || chapter.status === 'completed') && (
                                      <Menu as="div" className="relative inline-block text-left">
                                        <MenuButton
                                          className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-muted hover:text-foreground transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
                                          title="Chapter actions"
                                        >
                                          <DotsVerticalIcon className="h-5 w-5" />
                                        </MenuButton>
                                        <Transition
                                          as={Fragment}
                                          enter="transition ease-out duration-100"
                                          enterFrom="transform opacity-0 scale-95"
                                          enterTo="transform opacity-100 scale-100"
                                          leave="transition ease-in duration-75"
                                          leaveFrom="transform opacity-100 scale-100"
                                          leaveTo="transform opacity-0 scale-95"
                                        >
                                          <MenuItems
                                            anchor={{ to: 'bottom end', gap: '8px', padding: '12px' }}
                                            portal
                                            className="w-44 rounded-md bg-background shadow-lg ring-1 ring-black/5 focus:outline-none z-[70] p-1 origin-top-right"
                                          >
                                            {chapter.status === 'completed' && (
                                              <>
                                                <MenuItem>
                                                  {({ active }) => (
                                                    <button
                                                      onClick={() => setPendingDeleteChapter(chapter)}
                                                      className={`${active ? 'bg-offbase' : ''} text-red-500 group flex w-full items-center gap-2 rounded px-2 py-2 text-sm`}
                                                      title="Delete this chapter"
                                                    >
                                                      <XCircleIcon className="h-4 w-4" />
                                                      <span>Delete</span>
                                                    </button>
                                                  )}
                                                </MenuItem>
                                                <MenuItem>
                                                  {({ active }) => (
                                                    <button
                                                      onClick={() => handleDownloadChapter(chapter)}
                                                      className={`${active ? 'bg-offbase text-accent' : 'text-foreground'} group flex w-full items-center gap-2 rounded px-2 py-2 text-sm`}
                                                    >
                                                      <DownloadIcon className="h-4 w-4" />
                                                      <span>Download</span>
                                                    </button>
                                                  )}
                                                </MenuItem>
                                              </>
                                            )}
                                            {regeneratingChapter === chapter.index && (
                                              <MenuItem>
                                                {({ active }) => (
                                                  <button
                                                    onClick={handleCancel}
                                                    className={`${active ? 'bg-offbase text-red-500' : 'text-red-500'} group flex w-full items-center gap-2 rounded px-2 py-2 text-sm`}
                                                    title="Cancel this chapter regeneration"
                                                  >
                                                    <XCircleIcon className="h-4 w-4" />
                                                    <span>Cancel</span>
                                                  </button>
                                                )}
                                              </MenuItem>
                                            )}
                                            {onRegenerateChapter && !isGenerating && (
                                              <MenuItem disabled={regeneratingChapter !== null}>
                                                {({ active, disabled }) => (
                                                  <button
                                                    onClick={() => handleRegenerateChapter(chapter)}
                                                    disabled={disabled}
                                                    className={`${active ? 'bg-offbase text-accent' : 'text-foreground'} group flex w-full items-center gap-2 rounded px-2 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
                                                    title="Regenerate this chapter"
                                                  >
                                                    <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index ? 'animate-spin' : ''}`} />
                                                    <span>{regeneratingChapter === chapter.index ? 'Regenerating...' : 'Regenerate'}</span>
                                                  </button>
                                                )}
                                              </MenuItem>
                                            )}
                                          </MenuItems>
                                          {/* end of menu items */}
                                        </Transition>
                                      </Menu>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {bookId && !isGenerating && (
                              <div className="pt-4 border-t border-offbase">
                                <Button
                                  onClick={handleDownloadComplete}
                                  disabled={isCombining}
                                  className="w-full inline-flex justify-center items-center space-x-2 rounded-lg bg-accent px-3 py-1.5 text-sm
                                        disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
                                        font-medium text-background hover:bg-secondary-accent focus:outline-none 
                                        focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                        transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-background"
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
                            <p className="text-sm text-muted">
                            Audiobook settings are fixed after generation. Chapters will appear here as they are ready.
                            <br></br>
                            You can close this dialog while the audiobook is being generated. But returning to the home screen will cancel the generation.
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="mt-6 flex justify-end">
                        <Button
                          type="button"
                          className="inline-flex justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                               font-medium text-foreground hover:bg-offbase focus:outline-none 
                               focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                               transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
                          onClick={() => setIsOpen(false)}
                        >
                          Close
                        </Button>
                      </div>
                    </>
                  )}
                </DialogPanel>
              </TransitionChild>
            </div>
          </div>
        </Dialog>
      </Transition>
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
