import { ticksToSeconds, type Score } from '../core';
import { useStore } from '../store';
import type { TransportHooks } from '../video/sync';
import { onPlaybackEvent, pausePlayback, seekTo, startPlayback } from './playback';

/** Inverse of ticksToSeconds (monotonic), by bisection so the tempo-map maths stays in one place. */
export function secondsToTick(score: Score, sec: number): number {
  if (sec <= 0) return 0;
  let lo = 0;
  let hi = Math.max(score.ppq * 4, 1);
  while (ticksToSeconds(score, hi) < sec && hi < 1e9) hi *= 2;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (ticksToSeconds(score, mid) < sec) lo = mid;
    else hi = mid;
  }
  return Math.round(hi);
}

/** Connects the sync controller to the real transport (playback.ts events + store state). */
export function createTransportHooks(): TransportHooks {
  const score = () => useStore.getState().score;
  const secs = (tick: number) => {
    const s = score();
    return s ? ticksToSeconds(s, tick) : 0;
  };
  const tickOf = (sec: number) => {
    const s = score();
    return s ? secondsToTick(s, sec) : 0;
  };
  return {
    isPlaying: () => useStore.getState().playback.isPlaying,
    getSeconds: () => secs(useStore.getState().playback.tick),
    play: (sec) => void startPlayback(tickOf(sec)).catch(() => {}),
    pause: () => pausePlayback(),
    seek: (sec) => void seekTo(tickOf(sec)).catch(() => {}),
    subscribe(cb) {
      const offEvents = onPlaybackEvent((e) => {
        if (e.type === 'play') cb({ type: 'play', sec: secs(e.tick) });
        else if (e.type === 'seek') cb({ type: 'seek', sec: secs(e.tick) });
        else if (e.type === 'pause') cb({ type: 'pause' });
        else cb({ type: 'stop' });
      });
      const offRate = useStore.subscribe((st, prev) => {
        if (st.playback.tempoScale !== prev.playback.tempoScale) cb({ type: 'rate', rate: st.playback.tempoScale });
      });
      return () => {
        offEvents();
        offRate();
      };
    },
  };
}
