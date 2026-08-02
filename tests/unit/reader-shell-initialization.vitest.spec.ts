import { StrictMode, createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  useReaderSurfaceAdoption,
  useReaderSurfaceAttempt,
} from '@/hooks/useReaderSurfaceAdoption';
import type { ReaderType } from '@/types/user-state';

function AdoptionProbe({
  attemptKey,
  readerType,
  adopt,
  nonce = 0,
}: {
  attemptKey: string;
  readerType: ReaderType;
  adopt: (readerType: ReaderType) => void;
  nonce?: number;
}) {
  const state = useReaderSurfaceAdoption({
    attemptKey,
    enabled: true,
    // This wrapper is new on every render, just like a context callback can be.
    adopt: () => adopt(readerType),
  });
  return createElement('div', {
    'data-adopted': state.adoptedAttemptKey ?? '',
    'data-error': state.failure?.error.message ?? '',
    'data-nonce': nonce,
  });
}

function RestartProbe({
  adopt,
  restartBootstrap,
  onRestart,
  captureRestart,
}: {
  adopt: () => void;
  restartBootstrap: () => Promise<void>;
  onRestart: () => void;
  captureRestart: (restart: () => Promise<void>) => void;
}) {
  const surfaceAttempt = useReaderSurfaceAttempt({ restartBootstrap, onRestart });
  const state = useReaderSurfaceAdoption({
    attemptKey: `pdf:same-surface:${surfaceAttempt.attempt}`,
    enabled: !surfaceAttempt.isRestarting,
    adopt,
  });
  captureRestart(surfaceAttempt.restart);
  return createElement('div', {
    'data-attempt': surfaceAttempt.attempt,
    'data-restarting': String(surfaceAttempt.isRestarting),
    'data-adopted': state.adoptedAttemptKey ?? '',
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLElement;
let restoreDom: (() => void) | null = null;

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: parsed.window,
    document: parsed.document,
    Node: parsed.window.Node,
    Element: parsed.window.Element,
    HTMLElement: parsed.window.HTMLElement,
    Event: parsed.window.Event,
    navigator: parsed.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    defineGlobal(name, value);
  }
  restoreDom = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  };
  container = parsed.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom?.();
  restoreDom = null;
});

describe('reader surface adoption', () => {
  for (const readerType of ['pdf', 'epub', 'html'] as const) {
    test(`adopts ${readerType} once under Strict Mode and 50 unrelated rerenders`, async () => {
      const adopt = vi.fn();
      const render = (attemptKey: string, nonce: number) => createElement(
        StrictMode,
        { key: 'strict-root' },
        createElement(AdoptionProbe, { key: 'probe', attemptKey, readerType, adopt, nonce }),
      );

      await act(async () => root.render(render(`${readerType}:surface-one:0`, 0)));
      expect(adopt).toHaveBeenCalledTimes(1);

      for (let index = 1; index <= 50; index += 1) {
        await act(async () => root.render(render(`${readerType}:surface-one:0`, index)));
      }
      expect(adopt).toHaveBeenCalledTimes(1);

      await act(async () => root.render(render(`${readerType}:surface-two:0`, 51)));
      expect(adopt).toHaveBeenCalledTimes(2);
    });
  }

  test('keeps adoption failure terminal until an explicit attempt key changes', async () => {
    const adopt = vi.fn(() => {
      throw new Error('source mismatch');
    });
    const render = (attemptKey: string) => createElement(
      StrictMode,
      null,
      createElement(AdoptionProbe, { attemptKey, readerType: 'pdf', adopt }),
    );

    await act(async () => root.render(render('pdf:surface:0')));
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-error]')?.getAttribute('data-error')).toBe('source mismatch');

    for (let index = 0; index < 10; index += 1) {
      await act(async () => root.render(render('pdf:surface:0')));
    }
    expect(adopt).toHaveBeenCalledTimes(1);

    await act(async () => root.render(render('pdf:surface:1')));
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  test('reopens adoption for an equal-identity surface after aggregate restart settles', async () => {
    const pendingRestart = deferred();
    const adopt = vi.fn();
    const onRestart = vi.fn();
    const restartBootstrap = vi.fn(() => pendingRestart.promise);
    let restart!: () => Promise<void>;

    await act(async () => root.render(createElement(
      StrictMode,
      null,
      createElement(RestartProbe, {
        adopt,
        restartBootstrap,
        onRestart,
        captureRestart: (value) => {
          restart = value;
        },
      }),
    )));
    expect(adopt).toHaveBeenCalledTimes(1);

    let restartPromise!: Promise<void>;
    act(() => {
      restartPromise = restart();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(restartBootstrap).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-restarting]')?.getAttribute('data-restarting')).toBe('true');
    expect(container.querySelector('[data-attempt]')?.getAttribute('data-attempt')).toBe('1');
    expect(adopt).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingRestart.resolve();
      await restartPromise;
    });
    expect(container.querySelector('[data-restarting]')?.getAttribute('data-restarting')).toBe('false');
    expect(adopt).toHaveBeenCalledTimes(2);
  });
});
