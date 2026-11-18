import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { Rendition } from 'epubjs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EPUBDocument } from '@/types/documents';

const mocks = vi.hoisted(() => ({
  following: { current: false },
  resolve: vi.fn(),
  reconcile: vi.fn(),
  skip: vi.fn(),
  setIsEpub: vi.fn(),
  setFollowing: vi.fn(),
  resolvePlan: vi.fn(),
  segments: [],
}));
vi.mock('@/contexts/TTSContext', () => ({ useTTS: () => ({
  currDocPage: 1, currDocPages: 2, playbackPlanReady: false,
  playbackPlanSegmentCount: 0, currentSentenceOrdinal: null, playbackSegments: mocks.segments,
  followingNarration: false, followingNarrationRef: mocks.following,
  reconcileEpubRenderedAnchor: mocks.reconcile, resolveEpubPlanLocator: mocks.resolvePlan,
  setIsEPUB: mocks.setIsEpub, skipToOrdinal: mocks.skip, setFollowingNarration: mocks.setFollowing,
}) }));
vi.mock('@/contexts/ReaderAppearanceContext', () => ({ useReaderAppearance: () => ({
  presentation: { showsLayout: true, highlightSegment: true, highlightWords: true },
}) }));
vi.mock('@/hooks/epub/useEpubTapToSeek', () => ({ useEpubTapToSeek: vi.fn() }));
vi.mock('@/lib/client/epub/location-index', () => ({
  resolveEpubLocatorToCfi: mocks.resolve, clearEpubWindowIndex: vi.fn(),
}));

import { useEpubDocument } from '@/app/(app)/epub/[id]/useEpubDocument';

let root: Root;
let state: ReturnType<typeof useEpubDocument>;
const document = { id: 'epub-follow', name: 'book.epub', data: new ArrayBuffer(0) } as EPUBDocument;
const locator = { readerType: 'epub' as const, spineHref: 'chapter.xhtml', spineIndex: 0, charOffset: 100 };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.following.current = false;
  mocks.resolve.mockResolvedValue('15');
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  function Probe() { state = useEpubDocument(document, null); return null; }
  await act(async () => root.render(createElement(Probe)));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function rendition() {
  const display = vi.fn().mockResolvedValue(undefined);
  const value = {
    book: { isOpen: true, loaded: { metadata: Promise.resolve({}) } },
    on: vi.fn(), off: vi.fn(), getContents: () => [],
    hooks: { content: { register: vi.fn(), deregister: vi.fn() } },
    location: { start: { cfi: '20' }, end: { cfi: '30' } },
    epubcfi: { compare: (a: string, b: string) => Number(a) - Number(b) }, display,
  } as unknown as Rendition;
  await act(async () => state.setRendition(value));
  return display;
}

test('returns immediately using the current follow intent before React commits its rendered value', async () => {
  const display = await rendition();
  // Return to narration updates the authoritative command ref synchronously;
  // the reactive value still describes the preceding browsing render.
  mocks.following.current = true;
  await act(async () => state.handleLocationChanged(locator, 'playback-follow'));
  expect(display).toHaveBeenCalledWith('15');
});

test('discards a pending follow command when the user resumes browsing before resolution', async () => {
  const display = await rendition();
  let resolve!: (cfi: string) => void;
  mocks.resolve.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  mocks.following.current = true;
  await act(async () => state.handleLocationChanged(locator, 'playback-follow'));
  mocks.following.current = false;
  await act(async () => resolve('15'));
  expect(display).not.toHaveBeenCalled();
});
