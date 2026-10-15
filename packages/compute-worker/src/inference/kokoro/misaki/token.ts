/**
 * TypeScript port of Misaki's MToken, from the OpenReader iOS port (vendored
 * from kokoro-swift, a port of hexgrad/misaki). Apache-2.0; see
 * ../assets/LICENSE.txt. Timestamps are omitted: nothing here reads them.
 */

export interface TokenUnderscore {
  isHead: boolean;
  alias: string | null;
  stress: number | null;
  currency: string | null;
  numFlags: string;
  prespace: boolean;
  rating: number | null;
}

export interface MToken {
  text: string;
  tag: string;
  whitespace: string;
  phonemes: string | null;
  _: TokenUnderscore;
}

export function createUnderscore(overrides: Partial<TokenUnderscore> = {}): TokenUnderscore {
  return {
    isHead: true,
    alias: null,
    stress: null,
    currency: null,
    numFlags: '',
    prespace: false,
    rating: null,
    ...overrides,
  };
}

export function createToken(input: {
  text: string;
  tag: string;
  whitespace: string;
  phonemes?: string | null;
  underscore?: Partial<TokenUnderscore>;
}): MToken {
  return {
    text: input.text,
    tag: input.tag,
    whitespace: input.whitespace,
    phonemes: input.phonemes ?? null,
    _: createUnderscore(input.underscore),
  };
}

export function cloneToken(token: MToken): MToken {
  return { ...token, _: { ...token._ } };
}
