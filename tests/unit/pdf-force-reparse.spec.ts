import { expect, test } from '@playwright/test';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
  isForceReparseDisabled,
} from '../../src/lib/client/pdf/force-reparse';

test.describe('pdf force reparse controls', () => {
  test('disables action while parse is pending or running', () => {
    expect(isForceReparseDisabled('pending')).toBeTruthy();
    expect(isForceReparseDisabled('running')).toBeTruthy();
    expect(isForceReparseDisabled('ready')).toBeFalsy();
    expect(isForceReparseDisabled('failed')).toBeFalsy();
    expect(isForceReparseDisabled(null)).toBeFalsy();
  });

  test('confirmation copy warns about expensive rerun', () => {
    expect(FORCE_REPARSE_CONFIRM_TITLE).toContain('Reparse');
    expect(FORCE_REPARSE_CONFIRM_TEXT).toContain('Reparse');
    expect(FORCE_REPARSE_CONFIRM_MESSAGE.toLowerCase()).toContain('from scratch');
    expect(FORCE_REPARSE_CONFIRM_MESSAGE.toLowerCase()).toContain('take a while');
  });
});
