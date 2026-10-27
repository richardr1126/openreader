'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, IconButton, Input, ModalFrame, ModalTitle, RowIcon, Textarea } from '@/components/ui';
import { BookIcon, MicrophoneIcon, PauseIcon, PlayIcon, UploadIcon, UserPlusIcon, XIcon } from '@/components/icons/Icons';
import type { ClonedVoice } from '@openreader/tts/cloned-voices';

export const VOICE_RECORDING_SCRIPT = 'The library was quiet that evening. Rain tapped against the tall windows while I turned the pages slowly, reading each line aloud as if the story had been written just for me. Outside, the streetlights came on one by one.';
export interface VoiceCloningContext { providerRef: string; providerType: string; model: string; beforeCapture?: () => void }

export async function clonedVoiceRequest(method: string, payload?: unknown, signal?: AbortSignal) {
  const response = await fetch('/api/tts/cloned-voices', { method, signal,
    ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save your voice.');
  return result;
}

/** Convert only the selected interval; preferences never carry recording bytes. */
async function referenceWav(buffer: AudioBuffer, start: number, seconds: number): Promise<string> {
  const context = new OfflineAudioContext(1, Math.round(seconds * 24_000), 24_000);
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start(0, start, seconds);
  const rendered = await context.startRendering(); const samples = rendered.getChannelData(0);
  const wav = new Uint8Array(44 + samples.length * 2); const view = new DataView(wav.buffer);
  const label = (offset: number, value: string) => [...value].forEach((c, i) => { wav[offset + i] = c.charCodeAt(0); });
  label(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); label(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  let binary = ''; for (let i = 0; i < wav.length; i += 8192) binary += String.fromCharCode(...wav.subarray(i, i + 8192));
  return btoa(binary);
}

export function CloneVoiceEditor({ providerRef, providerType, model, beforeCapture, onSave, onClose }: VoiceCloningContext & {
  onSave: (voice: ClonedVoice) => void; onClose: () => void;
}) {
  const [name, setName] = useState(''); const [transcript, setTranscript] = useState('');
  const [audio, setAudio] = useState<AudioBuffer | null>(null); const [start, setStart] = useState(0); const [length, setLength] = useState(15);
  const [recording, setRecording] = useState(false); const [requesting, setRequesting] = useState(false);
  const [loading, setLoading] = useState(false); const [recordedSeconds, setRecordedSeconds] = useState(0); const [playing, setPlaying] = useState(false);
  const [permitted, setPermitted] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null); const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const mounted = useRef(true);
  const playback = useRef<AudioContext | null>(null); const request = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    const began = Date.now();
    const interval = setInterval(() => setRecordedSeconds((Date.now() - began) / 1000), 100);
    return () => clearInterval(interval);
  }, [recording]);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; request.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop());
    if (timer.current) clearTimeout(timer.current); void playback.current?.close();
  }; }, []);
  // A recording reads the shown passage, so it starts as the transcript; an
  // import's words are unknown.
  const load = async (blob: Blob, spoken = '') => {
    setError(''); setPermitted(false); setLoading(true); setPlaying(false);
    await playback.current?.close(); playback.current = null;
    const context = new AudioContext();
    try {
      if (blob.size > 20 * 1024 * 1024) throw new Error('Import an audio file smaller than 20 MB.');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (decoded.duration < 1) throw new Error('Use at least one second of clear speech.');
      if (mounted.current) { setAudio(decoded); setStart(0); setLength(Math.min(15.92, decoded.duration)); setTranscript(spoken); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { await context.close(); if (mounted.current) setLoading(false); }
  };
  const record = async () => {
    beforeCapture?.(); setError(''); setRequesting(true); setPermitted(false); setPlaying(false);
    await playback.current?.close(); playback.current = null;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media; const capture = new MediaRecorder(media); recorder.current = capture; const chunks: Blob[] = [];
      capture.ondataavailable = event => chunks.push(event.data);
      capture.onstop = () => {
        media.getTracks().forEach(track => track.stop()); recorder.current = null;
        if (timer.current) clearTimeout(timer.current);
        if (mounted.current) { setRecording(false); void load(new Blob(chunks, { type: capture.mimeType }), VOICE_RECORDING_SCRIPT); }
      };
      capture.start(); setRecordedSeconds(0); setRecording(true); setPermitted(false);
      timer.current = setTimeout(() => { if (capture.state === 'recording') capture.stop(); }, 16_000);
    } catch { stream.current?.getTracks().forEach(track => track.stop()); setError('Microphone access is unavailable. Allow microphone access or import an audio file.'); }
    finally { if (mounted.current) setRequesting(false); }
  };
  const clipLength = audio ? Math.max(1, Math.min(length, 15.92, audio.duration - start)) : 0;
  const playSelection = async () => {
    const wasPlaying = playing;
    await playback.current?.close(); playback.current = null; setPlaying(false);
    if (wasPlaying || !audio) return;
    beforeCapture?.();
    const context = new AudioContext(); playback.current = context;
    const source = context.createBufferSource(); source.buffer = audio; source.connect(context.destination);
    source.onended = () => { if (mounted.current && playback.current === context) setPlaying(false); };
    source.start(0, start, clipLength); setPlaying(true);
  };
  const transcriptRequired = providerType === 'fish-audio';
  const canSave = !!audio && !!name.trim() && (!transcriptRequired || !!transcript.trim()) && permitted && !saving && !recording && !requesting && !loading;
  const save = async () => {
    if (!audio || !canSave) return;
    setSaving(true); setError(''); const controller = new AbortController(); request.current = controller;
    try {
      const encoded = await referenceWav(audio, start, clipLength);
      const result = await clonedVoiceRequest('POST', { name, transcript, audio: encoded, permitted, providerRef, model }, controller.signal);
      if (mounted.current) onSave(result.voice);
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (mounted.current) setSaving(false); }
  };
  const disabled = saving || requesting || loading;
  const card = 'rounded-lg border border-line bg-surface-sunken p-3';
  return <ModalFrame open size="lg" onClose={() => { if (!audio && !recording && !disabled) onClose(); }}
    panelClassName="flex max-h-[calc(100dvh-2rem)] flex-col">
    <div className="flex shrink-0 items-center gap-3">
      <RowIcon><UserPlusIcon /></RowIcon>
      <ModalTitle className="flex-1">Create your own voice</ModalTitle>
      <IconButton aria-label="Close voice editor" disabled={disabled} onClick={onClose}><XIcon className="h-4 w-4" /></IconButton>
    </div>
    <div className="mt-4 space-y-4 overflow-y-auto" aria-busy={loading || saving}>
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-soft">Your sample is sent to {providerType === 'fish-audio' ? 'Fish Audio' : 'OpenRouter and its speech provider'} when generating audio. Provider charges may apply. Saved voices are private to your OpenReader account.</p>
      </div>
      <input ref={fileInput} type="file" accept="audio/*" aria-label="Import voice sample" className="sr-only" disabled={disabled || recording} onChange={event => {
        const file = event.target.files?.[0]; if (file) void load(file); event.target.value = '';
      }} />
      {loading ? <p role="status" className="text-sm text-soft">Preparing your sample…</p> : recording ? <div className="space-y-4">
        <div className={`${card} space-y-4`}>
          <h5 className="text-sm font-medium">Read this aloud</h5><p className="text-sm leading-relaxed text-soft">{VOICE_RECORDING_SCRIPT}</p>
          <div role="status" className="flex justify-between text-sm"><span className="text-accent">● Recording</span><span className="tabular-nums">{recordedSeconds.toFixed(1)} s</span></div>
          <p className="text-sm text-soft">{recordedSeconds < 10 ? 'Keep reading — at least 10 seconds works best.' : 'Stop whenever you finish a sentence.'}</p>
        </div>
        <Button variant="primary" onClick={() => recorder.current?.stop()}>Stop recording</Button>
      </div> : !audio ? <div className="space-y-4">
        <div className={`${card} space-y-2`}><h5 className="text-sm font-medium">For the best result</h5>
          <p className="flex items-center gap-2 text-xs text-soft"><UserPlusIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden />One person speaking for 10 to 15 seconds</p>
          <p className="flex items-center gap-2 text-xs text-soft"><MicrophoneIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden />A quiet room, with no music or other voices</p>
          <p className="flex items-center gap-2 text-xs text-soft"><BookIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden />An even, natural pace, as if reading aloud</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" disabled={disabled} onClick={() => void record()} className={`${card} flex min-h-28 flex-col items-center justify-center gap-2 text-center hover:border-accent-line hover:bg-accent-wash focus-visible:outline-accent disabled:opacity-50`}>
            <MicrophoneIcon className="h-6 w-6 text-accent" aria-hidden /><span className="text-sm font-medium">Record</span><span className="text-xs text-soft">Read a short passage</span>
          </button>
          <button type="button" disabled={disabled} onClick={() => fileInput.current?.click()} className={`${card} flex min-h-28 flex-col items-center justify-center gap-2 text-center hover:border-accent-line hover:bg-accent-wash focus-visible:outline-accent disabled:opacity-50`}>
            <UploadIcon className="h-6 w-6 text-accent" aria-hidden /><span className="text-sm font-medium">Import</span><span className="text-xs text-soft">Use an audio file</span>
          </button>
        </div>
      </div> : <fieldset disabled={saving} className="space-y-4">
        <div className={`${card} space-y-4`}>
          <div className="flex items-center justify-between gap-3"><div><h5 className="text-sm font-medium">Your sample</h5><p className="text-xs tabular-nums text-soft">{clipLength.toFixed(1)} of {audio.duration.toFixed(1)} seconds selected</p></div>
            <IconButton aria-label={playing ? 'Stop selection' : 'Play selection'} className="text-accent" onClick={() => void playSelection()}>{playing ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}</IconButton>
          </div>
          {audio.duration > 1.5 && <div className="space-y-3 text-sm">
            <label className="block"><span className="flex justify-between">Start<span className="tabular-nums">{start.toFixed(1)} s</span></span><input aria-label="Sample start" type="range" className="w-full accent-accent" min={0} max={Math.max(0, audio.duration - 1)} step={0.1} value={start} onChange={e => { setStart(Number(e.target.value)); setPermitted(false); }} /></label>
            <label className="block"><span className="flex justify-between">Length<span className="tabular-nums">{clipLength.toFixed(1)} s</span></span><input aria-label="Sample length" type="range" className="w-full accent-accent" min={1} max={Math.min(15.92, audio.duration - start)} step={0.1} value={clipLength} onChange={e => { setLength(Number(e.target.value)); setPermitted(false); }} /></label>
          </div>}
          <div className="flex flex-wrap gap-4"><Button variant="ghost" className="gap-2 px-0 text-accent" onClick={() => void record()}><MicrophoneIcon className="h-4 w-4" />Record again</Button><Button variant="ghost" className="gap-2 px-0 text-accent" onClick={() => fileInput.current?.click()}><UploadIcon className="h-4 w-4" />Import instead</Button></div>
        </div>
        <label className="block space-y-2"><span className="text-sm font-medium">Name</span><Input autoFocus aria-label="Voice name" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="For example, Grandpa reading" /></label>
        {transcriptRequired
          ? <label className="block space-y-2"><span className="text-sm font-medium">Sample transcript</span><Textarea aria-label="Sample transcript" placeholder="Words spoken in the selected clip" rows={3} maxLength={4000} value={transcript} onChange={e => setTranscript(e.target.value)} /><span className="block text-xs text-soft">Fish Audio needs the exact words spoken in the selected clip.</span></label>
          : <details className={card}><summary className="cursor-pointer text-sm font-medium">Sample transcript (optional)</summary><Textarea aria-label="Sample transcript" placeholder="Words spoken in the selected clip" className="mt-3" rows={3} maxLength={4000} value={transcript} onChange={e => setTranscript(e.target.value)} /><p className="mt-2 text-xs text-soft">Use the words spoken in the selected clip.</p></details>}
        <label className={`${card} flex cursor-pointer items-start gap-3`}><Checkbox className="mt-0.5 shrink-0" checked={permitted} onChange={e => setPermitted(e.target.checked)} /><span><span className="block text-sm font-medium">This is my voice, or I have permission from the person speaking to use it</span><span className="mt-1 block text-xs text-soft">Don&apos;t use a voice to impersonate someone or to pass off generated speech as their real words.</span></span></label>
      </fieldset>}
      {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    </div>
    <div className="mt-6 flex shrink-0 justify-end gap-3 border-t border-line-soft pt-4">
      <Button size="sm" variant="outline" disabled={disabled} onClick={onClose}>Cancel</Button>
      {audio && !recording && <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>
        {saving ? 'Saving voice…' : !name.trim() ? 'Name your voice to save' : transcriptRequired && !transcript.trim() ? 'Add the transcript to save' : !permitted ? 'Confirm permission to save' : 'Save voice'}
      </Button>}
    </div>
  </ModalFrame>;
}
