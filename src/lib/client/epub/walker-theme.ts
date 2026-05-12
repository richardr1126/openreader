export interface WalkerThemeSnapshot {
  foreground: string;
  base: string;
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
  letterSpacing?: string;
  wordSpacing?: string;
}

/**
 * Build epub.js theme rules for the hidden preload walker using the same core
 * typography metrics as the visible rendition.
 */
export function buildWalkerThemeRules(theme: WalkerThemeSnapshot): Record<string, Record<string, string>> {
  const bodyRules: Record<string, string> = {
    color: theme.foreground,
    'background-color': theme.base,
  };

  if (theme.fontFamily) bodyRules['font-family'] = theme.fontFamily;
  if (theme.fontSize) bodyRules['font-size'] = theme.fontSize;
  if (theme.lineHeight) bodyRules['line-height'] = theme.lineHeight;
  if (theme.fontWeight) bodyRules['font-weight'] = theme.fontWeight;
  if (theme.letterSpacing) bodyRules['letter-spacing'] = theme.letterSpacing;
  if (theme.wordSpacing) bodyRules['word-spacing'] = theme.wordSpacing;

  return { body: bodyRules };
}
