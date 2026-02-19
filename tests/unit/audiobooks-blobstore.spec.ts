import { test, expect } from '@playwright/test';
import {
  audiobookKey,
  audiobookPrefix,
  isMissingBlobError,
  isPreconditionFailed,
} from '../../src/lib/server/audiobooks/blobstore';

function configureS3Env() {
  process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
  process.env.S3_REGION = process.env.S3_REGION || 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || 'test-access';
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || 'test-secret';
  process.env.S3_PREFIX = 'openreader-test';
}

test.describe('audiobooks-blobstore', () => {
  test.beforeAll(() => {
    configureS3Env();
  });

  test('builds audiobook prefix with namespace', () => {
    const prefix = audiobookPrefix('book-123', 'user-abc', 'worker1');
    expect(prefix).toBe('openreader-test/audiobooks_v1/ns/worker1/users/user-abc/book-123-audiobook/');
  });

  test('builds audiobook prefix without namespace', () => {
    const prefix = audiobookPrefix('book-123', 'unclaimed', null);
    expect(prefix).toBe('openreader-test/audiobooks_v1/users/unclaimed/book-123-audiobook/');
  });

  test('builds key for chapter file', () => {
    const key = audiobookKey('book-123', 'user-abc', '0001__Chapter%201.mp3', null);
    expect(key).toBe('openreader-test/audiobooks_v1/users/user-abc/book-123-audiobook/0001__Chapter%201.mp3');
  });

  test('rejects invalid file names in keys', () => {
    expect(() => audiobookKey('book-123', 'user-abc', '../bad.mp3', null)).toThrow(/Invalid audiobook file name/);
  });

  test('detects missing blob errors', () => {
    expect(isMissingBlobError({ name: 'NoSuchKey' })).toBeTruthy();
    expect(isMissingBlobError({ $metadata: { httpStatusCode: 404 } })).toBeTruthy();
    expect(isMissingBlobError({ name: 'AccessDenied' })).toBeFalsy();
  });

  test('detects precondition failed errors', () => {
    expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBeTruthy();
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBeTruthy();
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 409 } })).toBeFalsy();
  });
});
