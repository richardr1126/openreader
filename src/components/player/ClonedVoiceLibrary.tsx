'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClonedVoice } from '@openreader/tts/cloned-voices';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { Button, IconButton, Input, MenuActionItem, MenuItemsSurface, MenuRoot, MenuTrigger, ModalFrame, ModalTitle } from '@/components/ui';
import { ChevronRightIcon, DotsHorizontalIcon, PencilIcon, PlusIcon, TrashIcon, UserPlusIcon } from '@/components/icons/Icons';
import { CloneVoiceEditor, clonedVoiceRequest, type VoiceCloningContext } from './CloneVoiceEditor';
import { VoicePickerRow, type VoicePickerPreview } from './VoicePicker';

type VoiceLibrary = { voices: ClonedVoice[]; supportsCloning: boolean };

export function ClonedVoiceLibrary({ cloning, value, onChange, preview, favorites, query, favoritesOnly, fallbackVoice }: {
  cloning: VoiceCloningContext; value: string; onChange: (voice: string) => void;
  preview: VoicePickerPreview; query: string; favoritesOnly: boolean;
  fallbackVoice: string;
  favorites?: { voices: Set<string>; toggle: (voice: string) => Promise<void>; available: boolean };
}) {
  const { data: session } = useAuthSession();
  const sessionId = session?.user?.id ?? '';
  const queryClient = useQueryClient();
  const libraryKey = queryKeys.clonedVoices(sessionId, cloning.providerRef, cloning.model);
  const library = useQuery<VoiceLibrary>({ queryKey: libraryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/tts/cloned-voices?${new URLSearchParams({ providerRef: cloning!.providerRef, model: cloning!.model })}`, { signal });
      if (!response.ok) throw new Error('Could not load your voices.');
      return response.json();
    }, enabled: !!sessionId && !!cloning.model, staleTime: 60_000 });
  const personal = (library.data?.voices ?? []).filter(v => v.providerRef === cloning?.providerRef && v.model === cloning?.model);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<{ voice: ClonedVoice; action: 'rename' | 'delete' } | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [mutating, setMutating] = useState(false);
  const mutateVoice = async (method: string, id: string) => {
    setMutating(true); setVoiceError('');
    try {
      preview.stop();
      const result = await clonedVoiceRequest(method, { id, name: voiceName });
      // A successful deletion owns the visible list immediately. Waiting for
      // a refetch left the removed voice selectable until the next interaction.
      await queryClient.cancelQueries({ queryKey: queryKeys.clonedVoicesRoot(sessionId) });
      queryClient.setQueriesData<VoiceLibrary>({ queryKey: queryKeys.clonedVoicesRoot(sessionId) }, previous => previous && ({ ...previous,
        voices: method === 'DELETE' ? previous.voices.filter(v => v.id !== id)
          : previous.voices.map(v => v.id === id ? result.voice : v) }));
      if (method === 'DELETE' && value === id) onChange(fallbackVoice);
      setManaging(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoicesRoot(sessionId) });
    }
    catch (e) { setVoiceError((e as Error).message); }
    finally { setMutating(false); }
  };
  return <div className="space-y-2">
    <h4 className="pt-2 text-sm font-semibold text-soft">Your voices</h4>
    {personal.filter(v => (!favoritesOnly || favorites?.voices.has(v.id)) && v.name.toLowerCase().includes(query.toLowerCase())).map(v =>
      <VoicePickerRow key={v.id} voice={v.id} name={v.name} note="Your voice" selected={value === v.id}
        onSelect={() => { preview.stop(); onChange(v.id); }} preview={preview} favorites={favorites} onError={setVoiceError}
        actions={<MenuRoot><MenuTrigger as={IconButton} size="sm" aria-label={`More for ${v.name}`}><DotsHorizontalIcon className="h-4 w-4" /></MenuTrigger>
          <MenuItemsSurface anchor="bottom end" portal className="z-[60] min-w-40">
            <MenuActionItem onClick={() => { setVoiceName(v.name); setVoiceError(''); setManaging({ voice: v, action: 'rename' }); }}><PencilIcon className="h-4 w-4" />Rename</MenuActionItem>
            <MenuActionItem tone="danger" onClick={() => { setVoiceError(''); setManaging({ voice: v, action: 'delete' }); }}><TrashIcon className="h-4 w-4" />Delete</MenuActionItem>
          </MenuItemsSurface></MenuRoot>} />)}
    {library.isPending && <p role="status" className="text-xs text-soft">Checking voice cloning…</p>}
    {library.data && !library.data.supportsCloning && <p className="text-xs text-soft">Voice cloning is unavailable for this model.</p>}
    {library.isError && <p role="alert" className="text-xs text-warning">Could not load your voices. <button onClick={() => void library.refetch()}>Try again</button></p>}
    {library.data?.supportsCloning && <button type="button" aria-label={personal.length ? 'Add another voice' : 'Create your own voice'} onClick={() => { preview.stop(); setCreating(true); }}
      className="flex w-full items-center gap-3 rounded-lg border border-dashed border-accent-line bg-surface-solid p-3 text-left hover:bg-accent-wash focus-visible:outline-accent">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">{personal.length ? <PlusIcon className="h-4 w-4" /> : <UserPlusIcon className="h-5 w-5" />}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{personal.length ? 'Add another voice' : 'Create your own voice'}</span><span className="block text-xs text-soft">Record or import a short sample</span></span><ChevronRightIcon className="h-4 w-4 text-soft" />
    </button>}
    {voiceError && !managing && <p role="alert" className="text-xs text-warning">{voiceError}</p>}
    {managing && <ModalFrame open onClose={() => { if (!mutating) setManaging(null); }}>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!mutating && (managing.action === 'delete' || voiceName.trim())) void mutateVoice(managing.action === 'delete' ? 'DELETE' : 'PATCH', managing.voice.id); }}>
        <ModalTitle>{managing.action === 'rename' ? 'Rename voice' : `Delete ${managing.voice.name}?`}</ModalTitle>
        {managing.action === 'rename' ? <Input autoFocus aria-label="Name" value={voiceName} maxLength={80} onChange={e => setVoiceName(e.target.value)} /> : <p className="text-sm text-soft">The saved sample is removed. Cached narration stays available.</p>}
        {voiceError && <p role="alert" className="text-sm text-warning">{voiceError}</p>}
        <div className="flex justify-end gap-3"><Button disabled={mutating} onClick={() => setManaging(null)}>Cancel</Button><Button type="submit" variant={managing.action === 'delete' ? 'danger' : 'primary'} disabled={mutating || (managing.action === 'rename' && !voiceName.trim())}>{managing.action === 'delete' ? 'Delete voice' : 'Save'}</Button></div>
      </form>
    </ModalFrame>}
    {creating && <CloneVoiceEditor key={`${cloning.providerRef}:${cloning.model}`} {...cloning} onClose={() => setCreating(false)} onSave={v => {
      queryClient.setQueryData<VoiceLibrary>(libraryKey, previous => previous && ({ ...previous, voices: [...previous.voices, v] }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoicesRoot(sessionId) }); onChange(v.id); setCreating(false);
    }} />}
  </div>;
}
