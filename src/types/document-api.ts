import type { BaseDocument } from './documents';

export type DocumentResource = BaseDocument & {
  status: 'not_started' | 'processing' | 'ready' | 'failed' | 'unknown';
  operationId: string | null;
  error: string | null;
  webUrl: string;
  fileUrl: string;
};

export type PreparedDocumentUpload = {
  id: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
};

export type DocumentUploadResource = {
  id: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  document: DocumentResource | null;
  operationId: string | null;
  error: string | null;
  statusUrl: string;
  eventsUrl: string | null;
};
