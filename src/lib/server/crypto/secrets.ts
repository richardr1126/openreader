import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Symmetric encryption for admin-managed secrets (API keys, etc).
 *
 * AES-256-GCM with a 256-bit key derived once via scrypt from AUTH_SECRET.
 * The IV is 12 bytes (GCM standard) and the auth tag is appended to the
 * ciphertext so we only need to persist (ciphertext, iv) in the DB.
 *
 * The persisted ciphertext is base64; ciphertext bytes = encrypted || tag(16).
 */

const KEY_SALT = 'openreader:admin-secrets:v1';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required to encrypt/decrypt admin secrets. ' +
        'Set AUTH_SECRET in your environment.',
    );
  }
  cachedKey = scryptSync(secret, KEY_SALT, KEY_LENGTH);
  return cachedKey;
}

export interface EncryptedSecret {
  ciphertext: string; // base64(encrypted || authTag)
  iv: string;         // base64(iv)
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecret expects a string');
  }
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decryptSecret(ciphertext: string, iv: string): string {
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    throw new TypeError('decryptSecret expects (string, string)');
  }
  const key = deriveKey();
  const ivBuffer = Buffer.from(iv, 'base64');
  const combined = Buffer.from(ciphertext, 'base64');
  if (combined.length < TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain auth tag');
  }
  const encrypted = combined.subarray(0, combined.length - TAG_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plaintext.toString('utf8');
}

export function apiKeyLast4(key: string): string {
  const trimmed = (key || '').trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}
