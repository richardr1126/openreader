export type EmailSettings = {
  enabled: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
  apiKeyConfigured: boolean;
  apiKeyMask: string | null;
};

export type EmailSettingsDraft = Pick<EmailSettings, 'enabled' | 'senderName' | 'senderEmail' | 'replyTo'>;

export function emailSettingsDraftFromResponse(settings: EmailSettings): EmailSettingsDraft {
  return {
    enabled: settings.enabled,
    senderName: settings.senderName,
    senderEmail: settings.senderEmail,
    replyTo: settings.replyTo,
  };
}

export function buildEmailSettingsPatch(
  draft: EmailSettingsDraft,
  apiKey: string,
): EmailSettingsDraft & { apiKey?: string } {
  return {
    enabled: draft.enabled,
    senderName: draft.senderName,
    senderEmail: draft.senderEmail,
    replyTo: draft.replyTo,
    ...(apiKey ? { apiKey } : {}),
  };
}
