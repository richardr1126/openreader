/**
 * Kokoro Utilities
 *
 * Utilities for handling Kokoro multi-voice syntax.
 */

/**
 * Parses a Kokoro voice string into individual voice names
 * Strips weights like "af_heart(0.5)" -> "af_heart"
 * 
 * @param voiceString - Voice string to parse (e.g., "af_heart(0.5)+bf_emma(0.5)")
 * @returns Array of voice names without weights
 */
export const parseKokoroVoiceNames = (voiceString: string): string[] =>
  voiceString
    .split('+')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/\([^)]*\)/g, '').trim());

/**
 * Builds a Kokoro voice string from an array of voice names
 * Automatically calculates equal weights for multiple voices
 * 
 * @param names - Array of voice names
 * @returns Formatted voice string with weights or single voice name
 */
export const buildKokoroVoiceString = (names: string[]): string => {
  const n = names.length;
  if (n === 0) return '';
  if (n === 1) return names[0];
  
  const weight = 1 / n;
  const weightString = weight.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return names.map(name => `${name}(${weightString})`).join('+');
};

/**
 * Checks if a model name is a Kokoro model
 * 
 * @param modelName - TTS model name
 * @returns True if the model is a Kokoro model
 */
export const isKokoroModel = (modelName: string | undefined): boolean => {
  return (modelName || '').toLowerCase().includes('kokoro');
};

/**
 * Determines the maximum number of voices allowed for a provider/model combination
 * 
 * @param provider - TTS provider name
 * @param model - TTS model name
 * @returns Maximum number of voices (Infinity for unlimited)
 */
export const getMaxVoicesForProvider = (provider: string, model: string): number => {
  if (!isKokoroModel(model)) return 1;
  
  // Deepinfra Kokoro does not support multiple voices
  if (provider === 'deepinfra') return 1;
  
  // Other providers with Kokoro support unlimited voices
  return Infinity;
};
