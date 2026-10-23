import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { VoicePicker } from '@/components/player/VoicePicker';
import { favoriteVoiceKey, normalizeFavoriteVoices, toggleFavoriteVoice } from '@/lib/shared/voice-favorites';
import { sanitizePreferencesPatch } from '@/lib/server/user/preferences-normalize';

describe('favorite identities and preference storage', () => {
  test('namespaces voices by concrete provider and model without separator collisions', () => {
    const first = { providerRef: 'a:b', ttsModel: 'c', voice: 'alloy' };
    const second = { providerRef: 'a', ttsModel: 'b:c', voice: 'alloy' };
    expect(favoriteVoiceKey(first)).not.toBe(favoriteVoiceKey(second));
    const entries = toggleFavoriteVoice(toggleFavoriteVoice([], first), second);
    expect(entries).toEqual([first, second]);
    expect(toggleFavoriteVoice(entries, first)).toEqual([second]);
  });

  test('normalizes stored preferences without relying on available providers or voices', () => {
    const entries = [
      { providerRef: ' missing-provider ', ttsModel: 'model:revision', voice: ' vanished-voice ' },
      { providerRef: 'missing-provider', ttsModel: 'model:revision', voice: 'vanished-voice' },
      { providerRef: '', ttsModel: 'model', voice: 'voice' },
      null,
    ];
    const expected = [{ providerRef: 'missing-provider', ttsModel: 'model:revision', voice: 'vanished-voice' }];
    expect(normalizeFavoriteVoices(entries)).toEqual(expected);
    const result = sanitizePreferencesPatch({ favoriteVoices: entries },
      { sharedProviders: [], showAllProviderModels: true }, { fillMissingProvider: false });
    expect(result.patch).toEqual({ favoriteVoices: expected });
    expect(sanitizePreferencesPatch({ favoriteVoices: [] },
      { sharedProviders: [], showAllProviderModels: true }, { fillMissingProvider: false }).patch.favoriteVoices).toEqual([]);
  });
});

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const dom = parseHTML('<html><body><main></main></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.querySelector('main') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

test('favorites do not select or preview a voice, and the filter can recover from empty', async () => {
  const select = vi.fn();
  const play = vi.fn();
  function Picker() {
    const [voices, setVoices] = useState(new Set<string>());
    return createElement(VoicePicker, {
      voices: ['alloy', 'nova'], value: 'alloy', onChange: select,
      pickPolicy: { multi: false, maxVoices: 1 }, groupByLanguage: false,
      preview: { state: { phase: 'idle' }, play, stop: vi.fn() },
      favorites: { voices, available: true, toggle: async (voice) => {
        setVoices((current) => {
          const next = new Set(current);
          if (!next.delete(voice)) next.add(voice);
          return next;
        });
      } },
    });
  }
  await act(async () => root.render(createElement(Picker)));
  const click = async (button: Element | null) => {
    expect(button).not.toBeNull();
    await act(async () => (button as HTMLElement).click());
  };
  await click(container.querySelector('[aria-label="Favorite nova"]'));
  expect(select).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Favorites') ?? null);
  expect(container.querySelector('[aria-label="Preview alloy"]')).toBeNull();
  expect(container.querySelector('[aria-label="Preview nova"]')).not.toBeNull();
  await click(container.querySelector('[aria-label="Remove nova from favorites"]'));
  expect(container.textContent).toContain('No favorite voices for this model.');
  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show all voices') ?? null);
  expect(container.querySelector('[aria-label="Preview alloy"]')).not.toBeNull();
  expect(select).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
});
