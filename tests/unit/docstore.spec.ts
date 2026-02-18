import { test, expect } from '@playwright/test';
import { getMigratedDocumentFileName } from '../../src/lib/server/storage/docstore-legacy';

test.describe('Docstore Filename Safety', () => {
  const id = 'a'.repeat(64); // Simulate sha256 hex ID

  test('should generate standard filename for short names', () => {
    const name = 'test-file.pdf';
    const result = getMigratedDocumentFileName(id, name);
    expect(result).toBe(`${id}__test-file.pdf`);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  test('should truncate very long names', () => {
    const longName = 'a'.repeat(300);
    const result = getMigratedDocumentFileName(id, longName);
    
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result).toContain('truncated-');
    expect(result.startsWith(`${id}__`)).toBeTruthy();
  });

  test('should truncate names that become too long after encoding', () => {
    // Chinese characters take 9 chars each when encoded (%XX%XX%XX)
    const specialName = '特殊字符'.repeat(30); 
    const result = getMigratedDocumentFileName(id, specialName);
    
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result).toContain('truncated-');
    // The implementation replaces the name with a hash, so it should NOT contain the original special chars
    // and might not contain % if the hash is hex.
    expect(result).toMatch(/truncated-[a-f0-9]{32}$/);
    expect(result.startsWith(`${id}__`)).toBeTruthy();
  });

  test('should handle edge case length exactly', () => {
     // Create a name that would result in exactly 241 chars to trigger truncation
     // Prefix is 64 + 2 = 66 chars.
     // Max allowed = 240.
     // Available for name = 240 - 66 = 174.
     // If we give 175 chars, it should truncate.
     const name = 'a'.repeat(175);
     const result = getMigratedDocumentFileName(id, name);
     expect(result).toContain('truncated-');
  });
  
  test('should not truncate if exactly at limit', () => {
     const name = 'a'.repeat(174);
     const result = getMigratedDocumentFileName(id, name);
     expect(result.length).toBe(240);
     expect(result).not.toContain('truncated-');
  });
});
