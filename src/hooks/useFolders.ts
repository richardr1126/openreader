'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { requestJson } from '@/lib/client/api/http';
import type { BaseDocument } from '@/types/documents';

export type ServerFolder = { id: string; name: string; position: number; createdAt?: number; updatedAt?: number };

function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, init, 'Folder request failed');
}

export function useFolders() {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const foldersKey = queryKeys.folders(sessionId);
  const documentsKey = queryKeys.documents(sessionId);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: foldersKey,
    queryFn: async ({ signal }) => (await jsonRequest<{ folders: ServerFolder[] }>('/api/folders', { signal })).folders,
    enabled: !isPending,
  });
  const create = useMutation({
    mutationFn: (input: { id?: string; name: string; documentIds?: string[] }) => jsonRequest<{ folder: ServerFolder }>('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }),
    onSuccess: ({ folder }, input) => {
      queryClient.setQueryData<ServerFolder[]>(foldersKey, (rows = []) => [...rows, folder]);
      if (input.documentIds?.length) queryClient.setQueryData<BaseDocument[]>(documentsKey, (rows = []) =>
        rows.map((doc) => input.documentIds!.includes(doc.id) ? { ...doc, folderId: folder.id } : doc));
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: foldersKey }),
      queryClient.invalidateQueries({ queryKey: documentsKey }),
    ]),
  });
  const move = useMutation({
    mutationFn: (input: { documentIds: string[]; folderId: string | null }) => jsonRequest('/api/documents/folders', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: documentsKey });
      const previous = queryClient.getQueryData<BaseDocument[]>(documentsKey);
      queryClient.setQueryData<BaseDocument[]>(documentsKey, (rows = []) =>
        rows.map((doc) => input.documentIds.includes(doc.id) ? { ...doc, folderId: input.folderId ?? undefined } : doc));
      return { previous };
    },
    onError: (_error, _input, context) => queryClient.setQueryData(documentsKey, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => jsonRequest(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: foldersKey }),
        queryClient.cancelQueries({ queryKey: documentsKey }),
      ]);
      const previousFolders = queryClient.getQueryData<ServerFolder[]>(foldersKey);
      const previousDocuments = queryClient.getQueryData<BaseDocument[]>(documentsKey);
      queryClient.setQueryData<ServerFolder[]>(foldersKey, (rows = []) => rows.filter((folder) => folder.id !== id));
      queryClient.setQueryData<BaseDocument[]>(documentsKey, (rows = []) => rows.map((doc) => doc.folderId === id ? { ...doc, folderId: undefined } : doc));
      return { previousFolders, previousDocuments };
    },
    onError: (_error, _id, context) => {
      queryClient.setQueryData(foldersKey, context?.previousFolders);
      queryClient.setQueryData(documentsKey, context?.previousDocuments);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: foldersKey }),
      queryClient.invalidateQueries({ queryKey: documentsKey }),
    ]),
  });
  const clear = useMutation({
    mutationFn: () => jsonRequest('/api/folders', { method: 'DELETE' }),
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: foldersKey }),
        queryClient.cancelQueries({ queryKey: documentsKey }),
      ]);
      const previousFolders = queryClient.getQueryData<ServerFolder[]>(foldersKey);
      const previousDocuments = queryClient.getQueryData<BaseDocument[]>(documentsKey);
      queryClient.setQueryData(foldersKey, []);
      queryClient.setQueryData<BaseDocument[]>(documentsKey, (rows = []) => rows.map((doc) => ({ ...doc, folderId: undefined })));
      return { previousFolders, previousDocuments };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(foldersKey, context?.previousFolders);
      queryClient.setQueryData(documentsKey, context?.previousDocuments);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: foldersKey }),
      queryClient.invalidateQueries({ queryKey: documentsKey }),
    ]),
  });
  return { query, create, move, remove, clear };
}
