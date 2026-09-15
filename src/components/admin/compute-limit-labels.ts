export function formatScope(scope: string): string {
  if (scope === 'anonymous_device') return 'anonymous device';
  return scope;
}

export function usageLabel(scope: string, audience: string): string {
  if (scope === 'anonymous_device') return 'anonymous device';
  if (scope === 'user') return `${audience} user`;
  return `${audience} ${formatScope(scope)}`;
}
