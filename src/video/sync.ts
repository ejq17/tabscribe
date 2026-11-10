/**
 * Keeps an embedded video and the tab transport in step. Pure logic: it only talks to the abstract
 * `VideoPlayer` and `TransportHooks` below, so it can be tested with fakes.
 *
 * The tab is master: transport play / pause / seek drive the video, and while playing the video is nudged back
 * when it drifts. The video's own controls drive the transport too (play, pause, scrubbing). Calls the controller
 * makes itself are remembered for a short window so their echoes are not mistaken for user actions.
 */
import type { VideoPlayer, VideoState } from './player';

export type TransportEvent =
  | { type: 'play'; sec: number }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; sec: number }
  | { type: 'rate'; rate: number };

export interface TransportHooks {
  isPlaying(): boolean;
  /** Current tab position in (unscaled) music seconds. */
  getSeconds(): number;
  /** Start / continue playing from this position. */
  play(sec: number): void;
  pause(): void;
  seek(sec: number): void;
  /** Subscribe to user-level transport events. Returns an unsubscribe function. */
  subscribe(cb: (e: TransportEvent) => void): () => void;
}

export interface SyncOptions {
  getStartSec: () => number;
  /** Tab speed multiplier right now (1 = normal). */
  getRate?: () => number;
  now?: () => number;
  driftThreshold?: number; // s, default 0.25
  jumpThreshold?: number; // s, default 1.5
  settleMs?: number; // default 1000
  echoMs?: number; // default 1500
  intervalMs?: number; // default 1000; 0 disables the built-in timer
}

export interface SyncController {
  /** One drift / scrub check (the built-in timer calls this). */
  tick(): void;
  /** True while the tab is waiting for the video to reach startSec. */
  isParked(): boolean;
  dispose(): void;
}

export function nearestRate(rates: number[], want: number): number {
  let best = rates[0] ?? 1;
  for (const r of rates) if (Math.abs(r - want) < Math.abs(best - want)) best = r;
  return best;
}

export function createSyncController(video: VideoPlayer, tr: TransportHooks, o: SyncOptions): SyncController {
  const now = o.now ?? (() => Date.now());
  const drift = o.driftThreshold ?? 0.25;
  const jump = o.jumpThreshold ?? 1.5;
  const settleMs = o.settleMs ?? 1000;
  const echoMs = o.echoMs ?? 1500;

  let settleUntil = 0; // no drift / scrub detection until then (after any seek we issue)
  let videoEcho: { state: VideoState; until: number } | null = null; // video state changes we caused
  let transportEchoes: { type: TransportEvent['type']; until: number }[] = []; // transport events we caused
  let parked = false;
  let lastVt = video.getTime();
  let playSec: number | null = null; // tab position when the last play began (tab may not have started yet)
  let playAt = 0;

  const startSec = () => Math.max(0, o.getStartSec());
  const markSettle = () => {
    settleUntil = now() + settleMs;
  };
  const seekVideo = (t: number) => {
    video.seek(t);
    lastVt = t;
    markSettle();
  };
  const videoCmd = (state: VideoState, fn: () => void) => {
    videoEcho = { state, until: now() + echoMs };
    fn();
  };
  const transportCmd = (type: TransportEvent['type'], fn: () => void) => {
    const t = now();
    transportEchoes = transportEchoes.filter((x) => x.until > t);
    transportEchoes.push({ type, until: t + echoMs });
    fn();
  };
  const setRate = (rate: number) => video.setRate(nearestRate(video.getAvailableRates(), rate));

  const onTransport = (e: TransportEvent) => {
    // play and seek are interchangeable: the transport restarts itself when seeking while playing.
    const same = (a: string, b: string) => a === b || (a !== 'pause' && a !== 'stop' && b !== 'pause' && b !== 'stop' && a !== 'rate' && b !== 'rate');
    const t0 = now();
    transportEchoes = transportEchoes.filter((x) => x.until > t0);
    const idx = transportEchoes.findIndex((x) => same(x.type, e.type));
    if (idx >= 0 && e.type !== 'rate') {
      transportEchoes.splice(idx, 1);
      // Our own transport command: the video already is where it should be.
      return;
    }
    switch (e.type) {
      case 'rate':
        setRate(e.rate);
        break;
      case 'play': {
        parked = false;
        if (o.getRate) setRate(o.getRate());
        playSec = e.sec;
        playAt = now();
        seekVideo(startSec() + e.sec);
        videoCmd('playing', () => video.play());
        break;
      }
      case 'pause':
      case 'stop':
        parked = false;
        playSec = null;
        videoCmd('paused', () => video.pause());
        break;
      case 'seek':
        parked = false;
        seekVideo(startSec() + e.sec);
        if (tr.isPlaying()) videoCmd('playing', () => video.play());
        break;
    }
  };

  /** The video reached or is past the start point: bring the tab in. */
  const startTabFromVideo = (vt: number) => {
    parked = false;
    playSec = Math.max(0, vt - startSec());
    playAt = now();
    transportCmd('play', () => tr.play(playSec as number));
  };

  const onVideoState = (s: VideoState) => {
    if (videoEcho && now() < videoEcho.until && videoEcho.state === s) {
      videoEcho = null;
      return;
    }
    if (s === 'buffering' || s === 'unstarted' || s === 'cued') return;
    const vt = video.getTime();
    if (s === 'playing') {
      if (tr.isPlaying()) return;
      if (vt < startSec()) {
        // Before the music starts: keep the tab at 0 and wait.
        parked = true;
        transportCmd('seek', () => tr.seek(0));
        return;
      }
      startTabFromVideo(vt);
    } else if (s === 'paused' || s === 'ended') {
      parked = false;
      if (tr.isPlaying()) transportCmd('pause', () => tr.pause());
    }
  };

  /** User scrubbed the video to vt. */
  const followScrub = (vt: number) => {
    markSettle();
    lastVt = vt;
    const rel = vt - startSec();
    if (rel < 0) {
      parked = true;
      if (tr.isPlaying()) transportCmd('pause', () => tr.pause());
      transportCmd('seek', () => tr.seek(0));
    } else if (tr.isPlaying()) {
      parked = false;
      transportCmd('seek', () => tr.seek(rel));
    } else if (parked && video.getState() === 'playing') {
      startTabFromVideo(vt);
    } else {
      parked = false;
      transportCmd('seek', () => tr.seek(rel));
    }
  };

  const tick = () => {
    const t = now();
    const vt = video.getTime();
    const vPlaying = video.getState() === 'playing';
    if (t < settleUntil) {
      lastVt = vt;
      return;
    }
    if (parked) {
      if (vPlaying && vt >= startSec()) startTabFromVideo(vt);
      else if (Math.abs(vt - lastVt) > jump && !vPlaying) followScrub(vt);
      lastVt = vt;
      return;
    }
    if (tr.isPlaying()) {
      const tab = tr.getSeconds();
      // Right after a play the tab may still be loading samples; don't fight it.
      if (playSec !== null && tab === playSec && t - playAt < 2500) {
        lastVt = vt;
        return;
      }
      if (!vPlaying) return; // paused / buffering video: nothing to measure
      const diff = vt - (startSec() + tab);
      if (Math.abs(diff) > jump) followScrub(vt);
      else if (Math.abs(diff) > drift) seekVideo(startSec() + tab);
      lastVt = vt;
      return;
    }
    // Transport stopped: a scrub of the (paused) video moves the tab cursor.
    if (Math.abs(vt - lastVt) > jump) followScrub(vt);
    else lastVt = vt;
  };

  const unsubTransport = tr.subscribe(onTransport);
  const unsubVideo = video.onStateChange(onVideoState);
  const timer = (o.intervalMs ?? 1000) > 0 ? setInterval(tick, o.intervalMs ?? 1000) : null;
  if (o.getRate) setRate(o.getRate());

  return {
    tick,
    isParked: () => parked,
    dispose() {
      unsubTransport();
      unsubVideo();
      if (timer) clearInterval(timer);
    },
  };
}
