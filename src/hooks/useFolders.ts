'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import { requestJson } from '@/lib/client/api/http';
import { deriveQueryState } from '@/lib/client/query/query-state';
import type { BaseDocument } from '@/types/documents';
import type { FolderResource } from '@/types/folder-api';

export type ServerFolder = FolderResource;

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
    queryFn: async ({ signal }) => {
      const folders: ServerFolder[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await jsonRequest<{ data: ServerFolder[]; nextCursor: string | null }>(`/api/v1/folders?${query}`, { signal });
        folders.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return folders;
    },
    enabled: !isPending,
  });
  const queryState = deriveQueryState({
    hasData: !isPending && query.data !== undefined,
    isFetching: isPending || query.isFetching,
    isError: query.isError,
    error: query.error,
  });
  const create = useMutation({
    mutationFn: async (input: { id?: string; name: string; documentIds?: string[] }) => {
      const folder = await jsonRequest<ServerFolder>('/api/v1/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, documentIds: input.documentIds?.slice(0, 200) }),
      });
      for (let offset = 200; offset < (input.documentIds?.length ?? 0); offset += 200) {
        await jsonRequest('/api/v1/documents', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: input.documentIds!.slice(offset, offset + 200), folderId: folder.id }) });
      }
      return folder;
    },
    onSuccess: (folder, input) => {
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
    mutationFn: async (input: { documentIds: string[]; folderId: string | null }) => {
      for (let offset = 0; offset < input.documentIds.length; offset += 200) {
        await jsonRequest('/api/v1/documents', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: input.documentIds.slice(offset, offset + 200), folderId: input.folderId }),
        });
      }
    },
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
    mutationFn: (id: string) => jsonRequest(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
    mutationFn: () => jsonRequest('/api/v1/folders', { method: 'DELETE' }),
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
  return { query, queryState, create, move, remove, clear };
}
