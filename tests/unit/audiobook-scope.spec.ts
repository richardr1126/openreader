import { test, expect } from '@playwright/test';
import { buildAllowedAudiobookUserIds, pickAudiobookOwner } from '../../src/lib/server/audiobooks/user-scope';

test.describe('audiobook scope selection', () => {
  test('uses only unclaimed scope when auth is disabled', () => {
    const result = buildAllowedAudiobookUserIds(false, null, 'unclaimed::ns');
    expect(result.preferredUserId).toBe('unclaimed::ns');
    expect(result.allowedUserIds).toEqual(['unclaimed::ns']);
  });

  test('includes both preferred and unclaimed scopes when auth is enabled', () => {
    const result = buildAllowedAudiobookUserIds(true, 'user-123', 'unclaimed::ns');
    expect(result.preferredUserId).toBe('user-123');
    expect(result.allowedUserIds).toEqual(['user-123', 'unclaimed::ns']);
  });

  test('deduplicates preferred/unclaimed ids when they are the same', () => {
    const result = buildAllowedAudiobookUserIds(true, 'unclaimed::ns', 'unclaimed::ns');
    expect(result.allowedUserIds).toEqual(['unclaimed::ns']);
  });

  test('prefers unclaimed owner when both scopes exist', () => {
    const owner = pickAudiobookOwner(['user-123', 'unclaimed::ns'], 'user-123', 'unclaimed::ns');
    expect(owner).toBe('unclaimed::ns');
  });

  test('falls back to preferred owner when unclaimed is missing', () => {
    const owner = pickAudiobookOwner(['user-123'], 'user-123', 'unclaimed::ns');
    expect(owner).toBe('user-123');
  });

  test('returns null when no matching owners exist', () => {
    const owner = pickAudiobookOwner([], 'user-123', 'unclaimed::ns');
    expect(owner).toBeNull();
  });
});
