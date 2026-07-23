export const queryKeys = {
  documents: (sessionId: string) => ['documents', sessionId] as const,
  readerBootstrap: (sessionId: string, documentId: string) => ['reader-bootstrap', sessionId, documentId] as const,
  libraryDocuments: (sessionId: string) => ['documents', sessionId, 'library'] as const,
  preferences: (sessionId: string) => ['preferences', sessionId] as const,
  onboarding: (sessionId: string) => ['onboarding', sessionId] as const,
  folders: (sessionId: string) => ['folders', sessionId] as const,
  sharedProviders: (sessionId: string) => ['tts-shared-providers', sessionId] as const,
  ttsVoices: (sessionId: string, providerRef: string, model: string) => ['tts-voices', sessionId, providerRef, model] as const,
  parsedDocument: (sessionId: string, documentId: string) => ['parsed-document', sessionId, documentId] as const,
  claimCounts: (sessionId: string) => ['claim-counts', sessionId] as const,
  rateLimit: (sessionId: string) => ['rate-limit', sessionId] as const,
  admin: (sessionId: string, scope: string) => ['admin', sessionId, scope] as const,
  // Changelog is public/global content, so it is keyed by URL rather than session.
  changelogManifest: (manifestUrl: string) => ['changelog', 'manifest', manifestUrl] as const,
  changelogReleaseBody: (manifestUrl: string, bodyPath: string) => ['changelog', 'body', manifestUrl, bodyPath] as const,
};
