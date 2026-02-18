import { test, expect } from '@playwright/test';
import { 
  sha256HexSoftwareFromBytes, 
  sha256HexFromString 
} from '../../src/lib/client/sha256';

test.describe('SHA256 Software Implementation', () => {
    // Known test vectors
    // "" -> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    // "abc" -> ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad

  test('hashes empty string correctly', () => {
    const input = new Uint8Array([]);
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(sha256HexSoftwareFromBytes(input)).toBe(expected);
  });

  test('hashes "abc" correctly', () => {
    const input = new TextEncoder().encode('abc');
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256HexSoftwareFromBytes(input)).toBe(expected);
  });
  
  test('matches WebCrypto/fallback output for long strings', async () => {
      // Create a longer input
      const text = 'a'.repeat(1000);
      const input = new TextEncoder().encode(text);
      
      const software = sha256HexSoftwareFromBytes(input);
      const automatic = await sha256HexFromString(text);
      
      expect(software).toBe(automatic);
  });
});
