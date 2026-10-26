'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClonedVoice } from '@openreader/tts/cloned-voices';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { Button, Input, cn } from '@/components/ui';
import { HeartIcon } from '@/components/icons/Icons';
import { CloneVoiceEditor, clonedVoiceRequest, type VoiceCloningContext } from './CloneVoiceEditor';
import { VoicePreviewButton, type VoicePickerPreview } from './VoicePicker';

export function ClonedVoiceLibrary({ cloning, value, onChange, preview, favorites, query, favoritesOnly, fallbackVoice }: {
  cloning: VoiceCloningContext; value: string; onChange: (voice: string) => void;
  preview: VoicePickerPreview; query: string; favoritesOnly: boolean;
  fallbackVoice: string;
  favorites?: { voices: Set<string>; toggle: (voice: string) => Promise<void>; available: boolean };
}) {
  const { data: session } = useAuthSession();
  const sessionId = session?.user?.id ?? '';
  const queryClient = useQueryClient();
  const library = useQuery<{ voices: ClonedVoice[]; supportsCloning: boolean }>({ queryKey: queryKeys.clonedVoices(sessionId, cloning.providerRef, cloning.model),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/tts/cloned-voices?${new URLSearchParams({ providerRef: cloning!.providerRef, model: cloning!.model })}`, { signal });
      if (!response.ok) throw new Error('Could not load your voices.');
      return response.json();
    }, enabled: !!sessionId, staleTime: 60_000 });
  const personal = (library.data?.voices ?? []).filter(v => v.providerRef === cloning?.providerRef && v.model === cloning?.model);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [mutating, setMutating] = useState(false);
  const mutateVoice = async (method: string, id: string) => {
    setMutating(true); setVoiceError('');
    try {
      preview.stop();
      await clonedVoiceRequest(method, { id, name: voiceName });
      if (method === 'DELETE' && value === id) onChange(fallbackVoice);
      await queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoicesRoot(sessionId) }); setManaging(null);
    }
    catch (e) { setVoiceError((e as Error).message); }
    finally { setMutating(false); }
  };
      return <div className="space-y-2 border-b border-line-soft pb-3">
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">Your voices</h4><Button size="sm" disabled={!library.data?.supportsCloning} onClick={() => { preview.stop(); setCreating(true); }}>New voice</Button></div>
        {library.isPending && <p role="status" className="text-xs text-soft">Checking voice cloning support…</p>}
        {library.data && !library.data.supportsCloning && <p className="text-xs text-soft">Voice cloning is unavailable for this model.</p>}
        {library.isError && <p role="alert" className="text-xs text-warning">Could not load your voices. <button onClick={() => void library.refetch()}>Try again</button></p>}
        {personal.filter(v => (!favoritesOnly || favorites?.voices.has(v.id)) && v.name.toLowerCase().includes(query.toLowerCase())).map(v => <div key={v.id} className="space-y-2">
          <div className={cn('flex items-center gap-2 rounded-md p-1', value === v.id && 'bg-accent-wash')}>
            <VoicePreviewButton previewKey={v.id} label={v.name} preview={preview} voice={v.id} />
            <button className="min-w-0 flex-1 truncate text-left text-sm" aria-pressed={value === v.id} onClick={() => { preview.stop(); onChange(v.id); }}>{v.name}</button>
            {favorites?.available && <Button size="sm" aria-label={`Favorite ${v.name}`} aria-pressed={favorites.voices.has(v.id)} onClick={() => void favorites.toggle(v.id).catch(() => setVoiceError('Could not save favorites.'))}><HeartIcon className="h-4 w-4" fill={favorites.voices.has(v.id) ? 'currentColor' : 'none'} /></Button>}
            <Button size="sm" aria-label={`Manage ${v.name}`} onClick={() => { setManaging(managing === v.id ? null : v.id); setVoiceName(v.name); }}>Edit</Button>
          </div>
          {managing === v.id && <div className="space-y-2 rounded-md border border-line-soft p-2"><Input aria-label="Rename voice" value={voiceName} maxLength={80} onChange={e => setVoiceName(e.target.value)} /><div className="flex flex-wrap gap-2"><Button size="sm" disabled={mutating || !voiceName.trim()} onClick={() => void mutateVoice('PATCH', v.id)}>Rename</Button><Button size="sm" disabled={mutating} onClick={() => void mutateVoice('DELETE', v.id)}>Delete saved voice</Button><Button size="sm" onClick={() => setManaging(null)}>Cancel</Button></div><p className="text-xs text-soft">Deleting removes this saved sample. Existing narration stays cached.</p></div>}
        </div>)}
        {voiceError && <p role="alert" className="text-xs text-warning">{voiceError}</p>}
        {creating && cloning && <CloneVoiceEditor key={`${cloning.providerRef}:${cloning.model}`} {...cloning} onClose={() => setCreating(false)} onSave={v => { void queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoicesRoot(sessionId) }); onChange(v.id); setCreating(false); }} />}
      </div>;
}
