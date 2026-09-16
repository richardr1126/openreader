import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

describe('account email UI', () => {
  test('uses the shared mail icon for email-specific states', () => {
    for (const relativePath of [
      'src/app/(app)/signup/page.tsx',
      'src/app/(app)/verify-email/page.tsx',
      'src/app/(app)/forgot-password/page.tsx',
    ]) {
      const page = source(relativePath);
      expect(page, relativePath).toContain("import { MailIcon } from '@/components/icons/Icons'");
      expect(page, relativePath).toContain('<MailIcon');
      expect(page, relativePath).not.toContain('>✉<');
    }
  });
});
