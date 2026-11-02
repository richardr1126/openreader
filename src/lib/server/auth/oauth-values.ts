/** Direct SQL reads bypass Better Auth's SQLite JSON decoding. */
export function oauthStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}
