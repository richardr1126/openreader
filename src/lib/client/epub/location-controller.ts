export type EpubLocation = string | number;

export function isDirectionalEpubLocation(location: EpubLocation): location is 'next' | 'prev' {
  return location === 'next' || location === 'prev';
}

export function shouldNavigateToDifferentCfi(
  location: EpubLocation,
  currentStartCfi: string | undefined,
): location is string {
  return typeof location === 'string'
    && !isDirectionalEpubLocation(location)
    && !!currentStartCfi
    && location !== currentStartCfi;
}

export function shouldPersistEpubLocation(
  documentId: string | undefined,
  previousLocation: EpubLocation,
): documentId is string {
  return typeof documentId === 'string' && documentId.length > 0 && previousLocation !== 1;
}
