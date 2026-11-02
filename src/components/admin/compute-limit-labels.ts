export function usageLabel(scope: string, audience: string): string {
  if (scope === 'site') return 'Site';
  if (audience === 'anonymous') return 'Guest';
  return audience === 'authenticated' ? 'Account' : 'All users';
}
