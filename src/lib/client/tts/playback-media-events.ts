/** Centralize media-element event policy so connection churn cannot change intent. */
export function installPlaybackMediaEvents(input: {
  audio: HTMLAudioElement;
  isCurrent: () => boolean; isPlaying: () => boolean; shouldRecoverEnd: () => boolean;
  /** The document's real audio is over; the stream's remainder is length padding. */
  reachedEnd: () => boolean;
  onPause: () => void; onBuffering: () => void; onRecover: () => void;
  onEnded: () => void; onTime: () => void; onPlaying: () => void;
}) {
  const { audio } = input;
  // The advertised stream length is an upper bound, so the document usually
  // finishes before the media element would fire `ended`. Both paths end once.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    input.onEnded();
  };
  audio.onplay = () => {
    if (!input.isCurrent() || !input.isPlaying() || audio.paused) return;
    input.onBuffering();
  };
  audio.onpause = () => {
    if (finished || !input.isCurrent()) return;
    input.onPause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  };
  audio.onended = () => {
    if (!input.isCurrent()) return;
    if (input.shouldRecoverEnd()) input.onRecover(); else finish();
  };
  audio.onerror = () => { if (input.isCurrent() && input.isPlaying()) input.onRecover(); };
  audio.ontimeupdate = () => {
    if (finished || !input.isCurrent()) return;
    input.onTime();
    if (input.reachedEnd()) {
      audio.pause();
      finish();
    }
  };
  audio.onwaiting = () => {
    if (input.isCurrent() && input.isPlaying() && !audio.paused) input.onBuffering();
  };
  audio.onstalled = null;
  audio.onplaying = () => {
    if (!input.isCurrent() || !input.isPlaying() || audio.paused) return;
    input.onPlaying();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  };
}
