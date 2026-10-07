import { describe, it, expect } from 'vitest';
import { transcribeSamples } from '../src/audio/transcribe';
import { nearestSample } from '../src/audio/samples';
import { secondsToTicks } from '../src/audio/player';
import { createEmptyScore, ticksToSeconds } from '../src/core';

function synth(): Float32Array {
  const sr = 44100;
  const freqs = [220, 277.18, 329.63, 440];
  const tone = Math.round(0.5 * sr);
  const gap = Math.round(0.05 * sr);
  const att = Math.round(0.02 * sr);
  const out = new Float32Array(freqs.length * (tone + gap));
  freqs.forEach((f, k) => {
    const o = k * (tone + gap);
    for (let i = 0; i < tone; i++) {
      const env = Math.min(1, i / att, (tone - i) / att);
      out[o + i] = 0.6 * env * Math.sin((2 * Math.PI * f * i) / sr);
    }
  });
  return out;
}

describe('transcribeSamples', () => {
  it('finds four sine notes', () => {
    const score = transcribeSamples(synth(), 44100, {});
    const notes = score.tracks[0].notes;
    expect(notes.map((n) => n.pitch)).toEqual([57, 61, 64, 69]);
    for (const n of notes) {
      expect(n.duration).toBeGreaterThanOrEqual(120);
      const sec = ticksToSeconds(score, n.duration);
      expect(sec).toBeGreaterThan(0.2);
      expect(sec).toBeLessThan(0.9);
    }
    expect(score.meta.source).toBe('audio');
    expect(score.tracks[0].program).toBe(25);
    expect(score.tracks[0].isGuitarTarget).toBe(true);
  });
  it('honors explicit bpm', () => {
    expect(transcribeSamples(synth(), 44100, { bpm: 90 }).tempos[0].bpm).toBe(90);
  });
});

describe('nearestSample', () => {
  it('exact match has rate 1', () => {
    expect(nearestSample([40, 43, 46], 43)).toEqual({ midi: 43, rate: 1 });
  });
  it('shifts by playbackRate', () => {
    const c = nearestSample([40, 43, 46], 45)!;
    expect(c.midi).toBe(46);
    expect(c.rate).toBeCloseTo(Math.pow(2, -1 / 12), 10);
    expect(nearestSample([40], 52)!.rate).toBeCloseTo(2, 10);
    expect(nearestSample([], 52)).toBeNull();
  });
});

describe('secondsToTicks', () => {
  it('inverts ticksToSeconds across tempo changes', () => {
    const s = createEmptyScore();
    s.tempos = [{ tick: 0, bpm: 120 }, { tick: 960, bpm: 60 }, { tick: 2400, bpm: 200 }];
    for (const t of [0, 100, 960, 1500, 2400, 5000]) {
      expect(secondsToTicks(s, ticksToSeconds(s, t))).toBeCloseTo(t, 6);
    }
  });
});
