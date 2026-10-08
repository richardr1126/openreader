'use client';

import { useEffect, useRef, useState } from 'react';

import { getDocumentPreviewStatus } from '@/lib/client/api/documents';
import type { ReaderType } from '@/types/user-state';

/** Seconds a hardware/OS skip moves when the request carries no offset. */
export const MEDIA_SESSION_DEFAULT_SEEK_OFFSET_SEC = 10;

export interface MediaSessionInput {
  title: string | null;
  artworkUrl: string | null;
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  playbackRate: number;
  togglePlay: () => void;
  skipForward: () => void;
  skipBackward: () => void;
  /** The player's one seek path; it keeps the canonical session. */
  seekTo: (seconds: number) => void;
}

/**
 * A position state the Media Session API accepts, or null when there is no
 * document duration yet. The API throws on a position past the duration or a
 * zero rate; pause is conveyed through `playbackState` instead.
 */
export function mediaPositionState(input: {
  positionSec: number;
  durationSec: number;
  playbackRate: number;
}): MediaPositionState | null {
  const { durationSec } = input;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const position = Number.isFinite(input.positionSec) ? input.positionSec : 0;
  const rate = Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1;
  return {
    duration: durationSec,
    position: Math.min(durationSec, Math.max(0, position)),
    playbackRate: rate,
  };
}

/** Target for an OS seek-forward/backward request, relative to the playhead. */
export function mediaSeekOffsetTarget(
  positionSec: number,
  durationSec: number,
  direction: 1 | -1,
  offsetSec?: number | null,
): number {
  const offset = offsetSec != null && Number.isFinite(offsetSec) && offsetSec > 0
    ? offsetSec
    : MEDIA_SESSION_DEFAULT_SEEK_OFFSET_SEC;
  const target = positionSec + direction * offset;
  return Math.max(0, durationSec > 0 ? Math.min(durationSec, target) : target);
}

function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Browsers reject actions they do not implement (older WebKit lacks seekto).
  }
}

/**
 * Lock-screen / hardware media controls for the reader. Handlers are bound
 * once and read the latest controls through a ref, so the high-frequency
 * playback clock never re-registers them.
 */
export function useMediaSession(input: MediaSessionInput) {
  const latestRef = useRef(input);
  useEffect(() => {
    latestRef.current = input;
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const latest = () => latestRef.current;
    setHandler('play', () => { if (!latest().isPlaying) latest().togglePlay(); });
    setHandler('pause', () => { if (latest().isPlaying) latest().togglePlay(); });
    setHandler('nexttrack', () => latest().skipForward());
    setHandler('previoustrack', () => latest().skipBackward());
    setHandler('seekto', (details) => {
      if (details.seekTime == null || !Number.isFinite(details.seekTime)) return;
      latest().seekTo(Math.max(0, details.seekTime));
    });
    setHandler('seekforward', (details) => {
      const { positionSec, durationSec, seekTo } = latest();
      seekTo(mediaSeekOffsetTarget(positionSec, durationSec, 1, details.seekOffset));
    });
    setHandler('seekbackward', (details) => {
      const { positionSec, durationSec, seekTo } = latest();
      seekTo(mediaSeekOffsetTarget(positionSec, durationSec, -1, details.seekOffset));
    });
    return () => {
      for (const action of [
        'play', 'pause', 'nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward',
      ] as const) {
        setHandler(action, null);
      }
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    };
  }, []);

  const { title, artworkUrl } = input;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Text-to-Speech',
      artist: 'OpenReader',
      ...(artworkUrl ? { artwork: [{ src: artworkUrl }] } : {}),
    });
  }, [artworkUrl, title]);

  const { isPlaying } = input;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // The OS extrapolates from the last state at the given rate, so whole-second
  // changes (plus every rate, duration, and play/pause change) keep it in sync
  // without a write per media clock tick.
  const positionSecond = Math.floor(input.positionSec);
  const { durationSec, playbackRate } = input;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    const state = mediaPositionState({
      positionSec: latestRef.current.positionSec,
      durationSec,
      playbackRate,
    });
    try {
      navigator.mediaSession.setPositionState(state ?? undefined);
    } catch {
      // A transiently inconsistent clock must not break the player.
    }
  }, [durationSec, isPlaying, playbackRate, positionSecond]);
}

/**
 * The document preview as media artwork, resolved once per document after
 * playback first starts. Only an already-ready preview is used: the proxy URL
 * is same-origin and cookie-authenticated, and the direct URL is a short-lived
 * presigned GET, so neither carries a credential the page does not already hold.
 */
export function useDocumentArtworkUrl(
  documentId: string | null,
  readerType: ReaderType,
  enabled: boolean,
): string | null {
  const [artwork, setArtwork] = useState<{ documentId: string; url: string | null } | null>(null);
  const supportsPreview = readerType === 'pdf' || readerType === 'epub';
  const resolved = artwork?.documentId === documentId;

  useEffect(() => {
    if (!enabled || !documentId || !supportsPreview || resolved) return undefined;
    const controller = new AbortController();
    void getDocumentPreviewStatus(documentId, { signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        setArtwork({
          documentId,
          url: status.kind === 'ready' ? (status.directUrl ?? status.presignUrl) : null,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setArtwork({ documentId, url: null });
      });
    return () => controller.abort();
  }, [documentId, enabled, resolved, supportsPreview]);

  return resolved ? artwork?.url ?? null : null;
}
