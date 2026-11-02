export function formatScope(scope: string): string {
  return scope;
}

export function usageLabel(scope: string, audience: string): string {
  if (scope === 'user') return `${audience} user`;
  return `${audience} ${formatScope(scope)}`;
}
