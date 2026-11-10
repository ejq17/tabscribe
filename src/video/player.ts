/** Thin wrapper around the YouTube IFrame Player API. Browser only; loaded lazily so the app works without it. */

export type VideoState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export interface VideoPlayer {
  load(id: string): void;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  getTime(): number;
  getState(): VideoState;
  setRate(r: number): void;
  getAvailableRates(): number[];
  /** 0..100 (YouTube's own scale) */
  setVolume(v: number): void;
  destroy(): void;
  /** Returns an unsubscribe function. */
  onStateChange(cb: (s: VideoState) => void): () => void;
}

// Minimal typings for the bits of window.YT we use.
interface YTPlayerInstance {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setPlaybackRate(r: number): void;
  getAvailablePlaybackRates(): number[];
  setVolume(v: number): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayerInstance;
}
type YTWindow = Window & { YT?: Partial<YTNamespace>; onYouTubeIframeAPIReady?: () => void };

const API_SRC = 'https://www.youtube.com/iframe_api';
let apiPromise: Promise<YTNamespace> | null = null;

/** Load the IFrame API script once. Rejects (and may be retried) when offline or blocked. */
export function loadYouTubeApi(timeoutMs = 15000): Promise<YTNamespace> {
  const w = window as YTWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT as YTNamespace);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (msg: string) => {
      apiPromise = null;
      script.remove();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('The YouTube player took too long to load.'), timeoutMs);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timer);
      resolve(w.YT as YTNamespace);
    };
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      fail('Could not load the YouTube player (offline or blocked). The tab still works without it.');
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

const STATES: Record<number, VideoState> = { [-1]: 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };

/** Create a player inside `container` (an element we own; YouTube replaces a child of it with an iframe). */
export async function createVideoPlayer(container: HTMLElement, id: string, startSec = 0): Promise<VideoPlayer> {
  const YT = await loadYouTubeApi();
  const host = document.createElement('div');
  container.appendChild(host);
  const listeners = new Set<(s: VideoState) => void>();
  let state: VideoState = 'unstarted';
  let destroyed = false;
  const yt = await new Promise<YTPlayerInstance>((resolve, reject) => {
    let inst: YTPlayerInstance | undefined;
    try {
      inst = new YT.Player(host, {
        videoId: id,
        playerVars: { enablejsapi: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin, start: Math.floor(startSec) },
        events: {
          onReady: () => resolve(inst as YTPlayerInstance),
          onStateChange: (e) => {
            state = STATES[e.data] ?? 'unstarted';
            if (!destroyed) listeners.forEach((l) => l(state));
          },
          onError: () => reject(new Error('YouTube could not play this video (private, removed, or embedding disabled).')),
        },
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  return {
    load: (vid) => yt.cueVideoById({ videoId: vid }),
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    seek: (sec) => yt.seekTo(Math.max(0, sec), true),
    getTime: () => yt.getCurrentTime() || 0,
    getState: () => state,
    setRate: (r) => yt.setPlaybackRate(r),
    getAvailableRates: () => {
      const r = yt.getAvailablePlaybackRates?.();
      return r?.length ? r : [1];
    },
    setVolume: (v) => yt.setVolume(Math.min(100, Math.max(0, v))),
    destroy: () => {
      destroyed = true;
      listeners.clear();
      try {
        yt.destroy();
      } catch {
        /* already gone */
      }
      host.remove();
    },
    onStateChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
