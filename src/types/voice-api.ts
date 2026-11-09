export type VoiceListResource = {
  data: Array<{ id: string; name: string }>;
  nextCursor: null;
  provider: string;
  model: string;
  /**
   * listed: the provider named these voices. defaults: it has no voice list, so
   * these are its standard voices. unreachable: it did not answer, so they are unconfirmed.
   */
  status: 'listed' | 'defaults' | 'unreachable';
};

export type SpeechProviderResource = {
  id: string;
  name: string;
  type: string;
  defaultModel: string;
  /** The provider and model in the user's saved speech settings. */
  selected: boolean;
  selectedModel: string | null;
  models: Array<{ id: string; name: string }>;
  acceptsCustomModel: boolean;
};

/** A voice this document has audio for that a request naming it reuses. */
export type CachedVoiceResource = {
  provider: string;
  model: string;
  voice: string;
  name: string;
  /** Speaking rate the cached audio was generated at. */
  modelSpeed: number;
  segments: number;
  /** Cached narration at 1x. */
  durationMs: number;
  updatedAt: number;
};
