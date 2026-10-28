/** Delimiter listing over an in-memory key set, matching `ArtifactStorage.listChildPrefixes`. */
export function listMemoryChildPrefixes(
  keys: Iterable<string>,
  prefix: string,
  options?: { startAfter?: string; limit?: number },
): string[] {
  const children = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) children.add(rest.slice(0, slash));
  }
  return [...children]
    .sort()
    .filter((child) => options?.startAfter === undefined || child > options.startAfter)
    .slice(0, options?.limit ?? Infinity);
}
