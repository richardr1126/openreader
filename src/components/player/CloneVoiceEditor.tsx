'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/components/ui';
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
  const [permitted, setPermitted] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null); const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const mounted = useRef(true);
  const playback = useRef<AudioContext | null>(null); const request = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; request.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop());
    if (timer.current) clearTimeout(timer.current); void playback.current?.close();
  }; }, []);
  const load = async (blob: Blob) => {
    setError(''); setPermitted(false);
    const context = new AudioContext();
    try {
      if (blob.size > 20 * 1024 * 1024) throw new Error('Import an audio file smaller than 20 MB.');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (decoded.duration < 1) throw new Error('Use at least one second of clear speech.');
      if (mounted.current) { setAudio(decoded); setStart(0); setLength(Math.min(15.92, decoded.duration)); setTranscript(''); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { await context.close(); }
  };
  const record = async () => {
    beforeCapture?.(); setError(''); setRequesting(true); setPermitted(false);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media; const capture = new MediaRecorder(media); recorder.current = capture; const chunks: Blob[] = [];
      capture.ondataavailable = event => chunks.push(event.data);
      capture.onstop = () => {
        media.getTracks().forEach(track => track.stop()); recorder.current = null;
        if (timer.current) clearTimeout(timer.current);
        if (mounted.current) { setRecording(false); void load(new Blob(chunks, { type: capture.mimeType })); }
      };
      capture.start(); setRecording(true); setPermitted(false);
      timer.current = setTimeout(() => { if (capture.state === 'recording') capture.stop(); }, 16_000);
    } catch { stream.current?.getTracks().forEach(track => track.stop()); setError('Microphone access is unavailable. Allow microphone access or import an audio file.'); }
    finally { if (mounted.current) setRequesting(false); }
  };
  const clipLength = audio ? Math.max(1, Math.min(length, 15.92, audio.duration - start)) : 0;
  const save = async () => {
    if (!audio || !permitted || !name.trim() || recording || requesting || saving) return;
    setSaving(true); setError(''); const controller = new AbortController(); request.current = controller;
    try {
      const encoded = await referenceWav(audio, start, clipLength);
      const result = await clonedVoiceRequest('POST', { name, transcript, audio: encoded, permitted, providerRef, model }, controller.signal);
      if (mounted.current) onSave(result.voice);
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <div role="region" aria-label="New voice" className="space-y-4 rounded-lg border border-line-soft p-4">
    <div><h4 className="text-lg font-semibold">Create your own voice</h4>
      <p className="mt-1 text-sm text-soft">Record or import clear speech. Your sample is sent to {providerType === 'fish-audio' ? 'Fish Audio' : 'OpenRouter and its speech provider'} when generating audio. Provider charges may apply.</p></div>
    {recording && <div className="space-y-2"><p className="text-sm">Read this aloud (up to 16 seconds)</p><p className="text-sm text-soft">{VOICE_RECORDING_SCRIPT}</p><p role="status" className="text-sm text-accent">Recording…</p></div>}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={saving || requesting} onClick={() => recording ? recorder.current?.stop() : void record()}>{recording ? 'Stop recording' : audio ? 'Record again' : 'Record voice'}</Button>
      <label className="cursor-pointer rounded-md border border-line-soft px-3 py-1.5 text-sm">Import audio<input type="file" accept="audio/*" aria-label="Import voice sample" className="sr-only" disabled={saving || recording} onChange={event => { const file = event.target.files?.[0]; if (file) void load(file); event.target.value = ''; }} /></label></div>
    {audio && !recording && <>
      <div className="space-y-2 text-sm"><p>Your sample · {clipLength.toFixed(1)} seconds selected</p>
        <label className="block">Start · {start.toFixed(1)} s<input aria-label="Sample start" type="range" className="w-full" min={0} max={Math.max(0, audio.duration - 1)} step={0.1} value={start} onChange={e => { setStart(Number(e.target.value)); setPermitted(false); }} /></label>
        <label className="block">Length · {clipLength.toFixed(1)} s<input aria-label="Sample length" type="range" className="w-full" min={1} max={Math.min(15.92, audio.duration - start)} step={0.1} value={clipLength} onChange={e => { setLength(Number(e.target.value)); setPermitted(false); }} /></label>
        <Button size="sm" disabled={saving} onClick={async () => { beforeCapture?.(); await playback.current?.close(); const context = new AudioContext(); playback.current = context; const source = context.createBufferSource(); source.buffer = audio; source.connect(context.destination); source.start(0, start, clipLength); }}>Play selection</Button>
      </div>
      <label className="block text-sm">Voice name<Input aria-label="Voice name" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="For example, Grandpa reading" /></label>
      <label className="block text-sm">Sample transcript (optional)<textarea aria-label="Sample transcript" className="mt-1 w-full rounded-md border border-line-soft bg-surface-solid p-2" rows={3} maxLength={4000} value={transcript} onChange={e => setTranscript(e.target.value)} /><span className="text-xs text-soft">Use the words spoken in the selected clip.</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={permitted} onChange={e => setPermitted(e.target.checked)} /><span>This is my voice, or I have permission from the person speaking to use it.</span></label>
    </>}
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    <div className="flex gap-2"><Button size="sm" disabled={!audio || !name.trim() || !permitted || saving || recording || requesting} onClick={() => void save()}>{saving ? 'Saving voice…' : 'Save voice'}</Button><Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button></div>
  </div>;
}
