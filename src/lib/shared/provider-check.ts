export type ProviderCheckStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface ProviderCheckItem {
  id: 'settings' | 'connection' | 'voices' | 'speech';
  label: string;
  status: ProviderCheckStatus;
  detail: string;
}
