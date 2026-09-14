import { describe, expect, test } from 'vitest';
import {
  buildEmailSettingsPatch,
  emailSettingsDraftFromResponse,
  type EmailSettings,
} from '../../src/components/admin/email-settings-form';

const response: EmailSettings = {
  enabled: false,
  senderName: 'OpenReader',
  senderEmail: 'updates@example.com',
  replyTo: null,
  apiKeyConfigured: false,
  apiKeyMask: null,
};

describe('admin email settings form payload', () => {
  test('projects public response metadata out of editable draft state', () => {
    expect(emailSettingsDraftFromResponse(response)).toEqual({
      senderName: 'OpenReader',
      senderEmail: 'updates@example.com',
      replyTo: null,
    });
  });

  test('never serializes read-only response fields in a configuration patch', () => {
    expect(buildEmailSettingsPatch(response, 're_test_key')).toEqual({
      senderName: 'OpenReader',
      senderEmail: 'updates@example.com',
      replyTo: null,
      apiKey: 're_test_key',
    });
  });
});
