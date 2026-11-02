export const API_SCOPES = ['documents:read', 'documents:write', 'audio:generate'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const OAUTH_SCOPES = [...API_SCOPES, 'offline_access'] as const;
export const API_SCOPE_LABELS: Record<string, string> = {
  'documents:read': 'Read your documents, folders, voices and audiobooks',
  'documents:write': 'Add, rename, move and delete your documents and folders',
  'audio:generate': 'Generate audiobooks using your speech providers and compute limits',
  offline_access: 'Keep access when you are away, until you disconnect this app',
};
