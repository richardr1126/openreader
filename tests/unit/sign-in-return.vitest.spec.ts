import { expect, test } from 'vitest';
import { signInPathFor, signInReturnPath } from '@/lib/shared/sign-in-return';

test('signing in returns to reader, download, upload and device links', () => {
  expect(signInPathFor('/pdf/doc')).toBe('/signin?returnTo=%2Fpdf%2Fdoc');
  expect(signInPathFor('/audiobooks/doc/file')).toBe('/signin?returnTo=%2Faudiobooks%2Fdoc%2Ffile');
  expect(signInPathFor('/app/settings')).toBe('/signin');
  expect(signInPathFor('/app/upload/f1')).toBe('/signin?returnTo=%2Fapp%2Fupload%2Ff1');
  expect(signInReturnPath('/app/upload')).toBe('/app/upload');
  expect(signInReturnPath('/epub/doc')).toBe('/epub/doc');
  expect(signInReturnPath('/audiobooks/doc/file')).toBe('/audiobooks/doc/file');
  expect(signInReturnPath('/oauth/device?user_code=ABC')).toBe('/oauth/device?user_code=ABC');
});

test('anything else, including another origin, goes to the library', () => {
  for (const value of [null, '', '/app/settings', '/pdf/doc/extra', '/app/upload/a/b', '//evil.example/pdf/doc', '/\\evil.example/pdf/doc', 'https://evil.example/oauth/device?x=1']) {
    expect(signInReturnPath(value)).toBe('/app');
  }
});
