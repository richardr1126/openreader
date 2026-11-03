export type VoiceListResource = {
  data: Array<{ id: string; name: string }>;
  nextCursor: null;
  provider: string;
  model: string;
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
