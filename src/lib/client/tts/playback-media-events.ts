/** Centralize media-element event policy so connection churn cannot change intent. */
export function installPlaybackMediaEvents(input: {
  audio: HTMLAudioElement; audioSpeed: number;
  isCurrent: () => boolean; isPlaying: () => boolean; shouldRecoverEnd: () => boolean;
  onPause: () => void; onBuffering: () => void; onRecover: () => void;
  onEnded: () => void; onTime: () => void; onPlaying: () => void;
}) {
  const { audio } = input;
  audio.onplay = () => {
    if (!input.isCurrent() || !input.isPlaying() || audio.paused) return;
    audio.playbackRate = input.audioSpeed; input.onBuffering();
  };
  audio.onpause = () => {
    if (!input.isCurrent()) return;
    input.onPause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  };
  audio.onended = () => {
    if (!input.isCurrent() || !input.isPlaying()) return;
    if (input.shouldRecoverEnd()) input.onRecover(); else input.onEnded();
  };
  audio.onerror = () => { if (input.isCurrent() && input.isPlaying()) input.onRecover(); };
  audio.ontimeupdate = () => { if (input.isCurrent()) input.onTime(); };
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
