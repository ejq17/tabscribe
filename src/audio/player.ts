/** Web Audio sampled-guitar player with lookahead scheduling. Browser only; do not import in unit tests except for pure helpers. */
import { guitarTrack, ticksToSeconds, timeSignatureAt } from '../core';
import type { GuitarConfig, Score } from '../core';
import { loadSamples, nearestSample } from './samples';

export interface PlayOptions {
  fromTick?: number;
  tempoScale?: number;
  onTick?: (tick: number) => void;
  onEnd?: () => void;
  metronome?: boolean;
  loop?: { from: number; to: number };
}

/** Inverse of `ticksToSeconds` (tempo-map aware). */
export function secondsToTicks(score: Score, seconds: number): number {
  const tempos = [...score.tempos].sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0) return (seconds * 120 * score.ppq) / 60;
  if (seconds <= 0) return 0;
  let remaining = seconds;
  for (let i = 0; i < tempos.length; i++) {
    const t = tempos[i];
    const next = tempos[i + 1];
    const secPerTick = 60 / t.bpm / score.ppq;
    if (!next) return t.tick + remaining / secPerTick;
    const segSec = (next.tick - t.tick) * secPerTick;
    if (remaining <= segSec) return t.tick + remaining / secPerTick;
    remaining -= segSec;
  }
  return 0;
}

interface PlayEvent {
  /** start in unscaled music seconds */
  t: number;
  /** duration in music seconds */
  dur: number;
  pitch: number;
  gain: number;
  click?: 'accent' | 'normal';
}

interface Base {
  music: number;
  ctx: number;
  scale: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  endCtx: number;
}

const LOOKAHEAD = 0.15;
const TIMER_MS = 25;
const RELEASE = 0.06;
const MIN_DUR = 0.08;
const MAX_RING = 1.5;

/** Build the sorted event list (notes with ties merged, plus optional metronome clicks). */
export function buildEvents(score: Score, metronome: boolean, extraEndTick = 0): { events: PlayEvent[]; endSec: number } {
  const track = guitarTrack(score);
  const notes = (track ? track.notes : score.tracks.flatMap((t) => t.notes)).slice().sort((a, b) => a.start - b.start);
  type Merged = { start: number; end: number; pitch: number; velocity: number };
  const merged: Merged[] = [];
  const open = new Map<number, Merged>();
  for (const n of notes) {
    if (n.tiedFromPrevious) {
      const prev = open.get(n.pitch);
      if (prev && prev.end >= n.start - 2) {
        prev.end = Math.max(prev.end, n.start + n.duration);
        continue;
      }
    }
    const m = { start: n.start, end: n.start + n.duration, pitch: n.pitch, velocity: n.velocity };
    merged.push(m);
    open.set(n.pitch, m);
  }
  let endTick = 0;
  const events: PlayEvent[] = merged.map((m) => {
    endTick = Math.max(endTick, m.end);
    const t = ticksToSeconds(score, m.start);
    return { t, dur: ticksToSeconds(score, m.end) - t, pitch: m.pitch, gain: Math.pow(Math.max(1, m.velocity) / 127, 1.3) };
  });
  const endSec = ticksToSeconds(score, endTick);
  if (metronome) {
    const limit = Math.max(endTick, extraEndTick);
    let tick = 0;
    let guard = 0;
    while (tick <= limit && guard++ < 100000) {
      const ts = timeSignatureAt(score, tick);
      const beat = (score.ppq * 4) / ts.denominator;
      const measure = beat * ts.numerator;
      const rel = (tick - ts.tick) % measure;
      events.push({ t: ticksToSeconds(score, tick), dur: 0.02, pitch: 0, gain: 1, click: rel === 0 ? 'accent' : 'normal' });
      tick += beat;
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, endSec };
}

function lowerBound(events: PlayEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private available: number[] = [];
  private click: AudioBuffer | null = null;
  private loadPromise: Promise<void> | null = null;
  private volume = 0.9;
  private useCompressor: boolean;

  private score: Score | null = null;
  private events: PlayEvent[] = [];
  private endSec = 0;
  private cursor = 0;
  private base: Base = { music: 0, ctx: 0, scale: 1 };
  private pending: Base | null = null;
  private scale = 1;
  private loopSec: { from: number; to: number } | null = null;
  private playing = false;
  private pausedMusic = 0;
  private hasSession = false;
  private opts: PlayOptions = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;
  private voices = new Set<Voice>();
  private token = 0;

  constructor(options: { compressor?: boolean } = {}) {
    this.useCompressor = options.compressor ?? true;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTick(): number {
    if (!this.score) return 0;
    return secondsToTicks(this.score, this.musicNow());
  }

  /** Create (lazily) and resume the AudioContext. Call from a user gesture. */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      if (this.useCompressor) {
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 20;
        comp.ratio.value = 4;
        comp.attack.value = 0.005;
        comp.release.value = 0.2;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      } else {
        this.master.connect(this.ctx.destination);
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      const ctx = this.ensureContext();
      this.loadPromise = loadSamples(ctx).then((s) => {
        this.buffers = s.buffers;
        this.click = s.click;
        this.available = [...s.buffers.keys()].sort((a, b) => a - b);
      });
      this.loadPromise.catch(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  setTempoScale(x: number): void {
    const s = Math.min(2, Math.max(0.25, x));
    if (this.playing && this.ctx) {
      const now = this.ctx.currentTime;
      const pos = this.musicNow();
      this.base = { music: pos, ctx: now, scale: s };
      if (this.pending && this.loopSec) {
        this.pending = { music: this.loopSec.from, ctx: now + (this.loopSec.to - pos) / s, scale: s };
      }
    }
    this.scale = s;
  }

  play(score: Score, _guitar: GuitarConfig, opts: PlayOptions = {}): void {
    this.stopInternal(false);
    const token = ++this.token;
    this.score = score;
    this.opts = opts;
    this.scale = Math.min(2, Math.max(0.25, opts.tempoScale ?? 1));
    const loopFrom = opts.loop ? ticksToSeconds(score, opts.loop.from) : 0;
    const loopTo = opts.loop ? ticksToSeconds(score, opts.loop.to) : 0;
    this.loopSec = opts.loop && loopTo > loopFrom ? { from: loopFrom, to: loopTo } : null;
    const built = buildEvents(score, !!opts.metronome, opts.loop?.to ?? 0);
    this.events = built.events;
    this.endSec = built.endSec;
    this.pausedMusic = ticksToSeconds(score, Math.max(0, opts.fromTick ?? 0));
    this.hasSession = true;
    this.ensureContext();
    void this.load().then(
      () => {
        if (token === this.token) this.begin(this.pausedMusic);
      },
      (e) => console.error('Sample loading failed', e),
    );
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedMusic = this.musicNow();
    this.halt();
    this.emitTick();
  }

  resume(): void {
    if (this.playing || !this.hasSession) return;
    this.token++;
    this.ensureContext();
    this.begin(this.pausedMusic);
  }

  stop(): void {
    this.stopInternal(true);
  }

  seek(tick: number): void {
    if (!this.score) return;
    const sec = Math.max(0, ticksToSeconds(this.score, Math.max(0, tick)));
    if (this.playing && this.ctx) {
      this.cancelVoices();
      this.base = { music: sec, ctx: this.ctx.currentTime, scale: this.scale };
      this.pending = null;
      this.cursor = lowerBound(this.events, sec);
      this.schedule();
    } else {
      this.pausedMusic = sec;
    }
    this.emitTick();
  }

  /** Audition a single pitch. */
  playNote(pitch: number, durationSec = 0.8): void {
    const ctx = this.ensureContext();
    const go = () => this.startVoice(pitch, ctx.currentTime + 0.01, durationSec, 0.8, true);
    if (this.available.length > 0) go();
    else void this.load().then(go, () => undefined);
  }

  // ---- internals ----

  private musicNow(): number {
    if (!this.playing || !this.ctx) return this.pausedMusic;
    const now = this.ctx.currentTime;
    if (this.pending && now >= this.pending.ctx) {
      this.base = this.pending;
      this.pending = null;
    }
    const raw = this.base.music + (now - this.base.ctx) * this.base.scale;
    return Math.max(0, raw);
  }

  private begin(musicSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.cancelVoices();
    this.playing = true;
    this.pending = null;
    this.base = { music: musicSec, ctx: ctx.currentTime + 0.05, scale: this.scale };
    this.cursor = lowerBound(this.events, musicSec);
    this.schedule();
    this.timer = setInterval(() => this.tickTimer(), TIMER_MS);
    const frame = () => {
      if (!this.playing) return;
      this.emitTick();
      this.raf = requestAnimationFrame(frame);
    };
    if (typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(frame);
  }

  private emitTick(): void {
    this.opts.onTick?.(this.currentTick);
  }

  private tickTimer(): void {
    if (!this.playing || !this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    this.schedule();
    if (!this.loopSec) {
      const pos = this.musicNow();
      const last = this.endSec + RELEASE;
      if (pos >= last && this.cursor >= this.events.length) {
        const cb = this.opts.onEnd;
        this.stopInternal(false);
        this.pausedMusic = 0;
        cb?.();
      }
    }
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    const now = ctx.currentTime;
    if (this.pending && now >= this.pending.ctx) {
      this.base = this.pending;
      this.pending = null;
    }
    const horizon = now + LOOKAHEAD;
    let sb = this.pending ?? this.base;
    for (let guard = 0; guard < 5000; guard++) {
      const ev = this.events[this.cursor];
      const loop = this.loopSec;
      const evT = ev ? ev.t : Infinity;
      if (loop && evT >= loop.to - 1e-9 && sb.music <= loop.to) {
        const boundary = sb.ctx + (loop.to - sb.music) / sb.scale;
        if (boundary > horizon) break;
        sb = { music: loop.from, ctx: boundary, scale: this.scale };
        this.pending = sb;
        this.cursor = lowerBound(this.events, loop.from);
        continue;
      }
      if (!ev) break;
      const evCtx = sb.ctx + (ev.t - sb.music) / sb.scale;
      if (evCtx > horizon) break;
      this.cursor++;
      if (evCtx < now - 0.05) continue; // too late (after seek/stall)
      const at = Math.max(evCtx, now);
      if (ev.click) this.startClick(at, ev.click === 'accent');
      else this.startVoice(ev.pitch, at, ev.dur / sb.scale, ev.gain, false);
    }
  }

  private startClick(at: number, accent: boolean): void {
    if (!this.ctx || !this.master || !this.click) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.click;
    src.playbackRate.value = accent ? 1.5 : 1;
    const g = this.ctx.createGain();
    g.gain.value = accent ? 0.9 : 0.5;
    src.connect(g);
    g.connect(this.master);
    src.start(at);
  }

  private startVoice(pitch: number, at: number, durSec: number, gain: number, audition: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const choice = nearestSample(this.available, pitch);
    if (!choice) return;
    const buffer = this.buffers.get(choice.midi);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = choice.rate;
    const g = ctx.createGain();
    const hold = Math.max(MIN_DUR, audition ? durSec : Math.min(durSec, MAX_RING));
    const end = at + hold;
    g.gain.setValueAtTime(gain, at);
    g.gain.setValueAtTime(gain, end);
    g.gain.linearRampToValueAtTime(0, end + RELEASE);
    src.connect(g);
    g.connect(this.master);
    src.start(at);
    src.stop(end + RELEASE + 0.02);
    const voice: Voice = { src, gain: g, endCtx: end + RELEASE };
    this.voices.add(voice);
    src.onended = () => {
      this.voices.delete(voice);
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  private cancelVoices(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + 0.03);
        v.src.stop(now + 0.04);
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
  }

  private halt(): void {
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = null;
    this.cancelVoices();
    this.pending = null;
  }

  private stopInternal(resetPosition: boolean): void {
    this.token++;
    this.halt();
    if (resetPosition) {
      this.pausedMusic = 0;
      this.hasSession = false;
      this.emitTick();
    }
  }
}
