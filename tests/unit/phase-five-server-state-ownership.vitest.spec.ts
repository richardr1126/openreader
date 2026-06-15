import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('phase five server-state ownership', () => {
  test('keeps audiobook status and chapter mutations in the audiobook query hook', () => {
    const modal = source('src/components/AudiobookExportModal.tsx');
    expect(modal).toContain('useAudiobookStatus(documentId');
    expect(modal).not.toContain('getAudiobookStatus');
    expect(modal).not.toContain('setChapters');
    expect(modal).not.toContain('setBookId');
  });

  test('keeps parsed PDF server state and SSE cache updates in the parsed document query hook', () => {
    const pdf = source('src/app/(app)/pdf/[id]/usePdfDocument.ts');
    const hook = source('src/hooks/useParsedPdfDocument.ts');
    expect(pdf).toContain('useParsedPdfDocument(documentId)');
    expect(pdf).not.toContain('subscribeParsedPdfDocumentEvents');
    expect(hook).toContain('queryKeys.parsedDocument');
    expect(hook).toContain('queryClient.setQueryData<ParsedPdfQueryState>');
  });

  test('loads voices and claims through centralized query hooks', () => {
    expect(source('src/hooks/audio/useVoiceManagement.ts')).toContain('queryKeys.ttsVoices');
    expect(source('src/components/auth/ClaimDataModal.tsx')).toContain('useClaimData(false)');
    expect(source('src/contexts/OnboardingFlowContext.tsx')).toContain('useClaimData(');
  });

  test('uses centralized keys for manifests, rate limits, and admin state', () => {
    expect(source('src/components/reader/SegmentsSidebar.tsx')).toContain('queryKeys.ttsManifest');
    expect(source('src/contexts/AuthRateLimitContext.tsx')).toContain('queryKeys.rateLimit');
    expect(source('src/components/admin/AdminProvidersPanel.tsx')).toContain('queryKeys.admin(sessionId');
  });
});
