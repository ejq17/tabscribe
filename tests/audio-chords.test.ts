import { describe, it, expect } from 'vitest';
import { buildEvents } from '../src/audio/player';
import { createEmptyScore, newNoteId, STANDARD_TUNING } from '../src/core';
import type { Score } from '../src/core';
import type { ChordEvent } from '../src/chords';

const PPQ = 480;
const BAR = PPQ * 4;

function chord(name: string, tick: number, duration: number): ChordEvent {
  return { name, tick, duration, root: 0, quality: '', pitches: [], source: 'omr' };
}

/** 4 bars of 4/4. Bar 0 and 1 carry a melody note; bars 2 and 3 are empty. */
function makeScore(): Score {
  const s = createEmptyScore();
  s.tracks.push({
    id: 't', name: 'g', program: 25, isGuitarTarget: true,
    notes: [0, BAR].map((start) => ({ id: newNoteId(), pitch: 72, start, duration: PPQ, velocity: 100, voice: 0 })),
  } as Score['tracks'][number]);
  return s;
}
// bars 0-1 C, bars 2-3 G
const chords = [chord('C', 0, 2 * BAR), chord('G', 2 * BAR, 2 * BAR)];
const sec = (tick: number) => (tick / PPQ) * 0.5; // 120 bpm

describe('buildEvents with chords', () => {
  it('adds nothing when chords are omitted', () => {
    const a = buildEvents(makeScore(), false);
    expect(a.events.every((e) => !e.chord)).toBe(true);
    expect(a.events).toHaveLength(2);
    expect(buildEvents(makeScore(), false, 0, { chords: [] }).events).toHaveLength(2);
  });

  it('voices open C major as C3 E3 G3 C4 E4, low string first, ascending offsets', () => {
    const { events } = buildEvents(makeScore(), false, 0, { chords, tuning: STANDARD_TUNING });
    const first = events.filter((e) => e.chord && Math.abs(e.t - sec(0)) < 0.2);
    expect(first.map((e) => e.pitch)).toEqual([48, 52, 55, 60, 64]);
    for (let i = 1; i < first.length; i++) {
      const gap = first[i].t - first[i - 1].t;
      expect(gap).toBeGreaterThanOrEqual(0.012);
      expect(gap).toBeLessThanOrEqual(0.02);
      expect(first[i].gain).toBeGreaterThan(first[i - 1].gain);
    }
  });

  it('plays a light pattern in melody bars and every beat in empty bars', () => {
    const { events } = buildEvents(makeScore(), false, 0, { chords });
    const strumTimes = (fromBar: number, toBar: number) => {
      const lows = events.filter((e) => e.chord && (e.pitch === 48 || e.pitch === 43));
      return lows.filter((e) => e.t >= sec(fromBar * BAR) - 1e-6 && e.t < sec(toBar * BAR)).length;
    };
    expect(strumTimes(0, 1)).toBe(1); // melody bar: beat 1 only
    expect(strumTimes(1, 2)).toBe(1);
    expect(strumTimes(2, 3)).toBe(4); // empty bar: every beat
    expect(strumTimes(3, 4)).toBe(4);
  });

  it('strums on a chord change inside a melody bar and keeps melody gain above chord gain', () => {
    const s = makeScore();
    const split = [chord('C', 0, 2 * PPQ), chord('G', 2 * PPQ, 4 * BAR - 2 * PPQ)];
    const { events } = buildEvents(s, false, 0, { chords: split });
    const bar0 = events.filter((e) => e.chord && e.t < sec(BAR) && (e.pitch === 48 || e.pitch === 43));
    expect(bar0).toHaveLength(2);
    const melody = events.find((e) => !e.chord)!;
    expect(Math.max(...events.filter((e) => e.chord).map((e) => e.gain))).toBeLessThan(melody.gain);
    const lightGain = bar0[0].gain;
    const emptyGain = events.find((e) => e.chord && e.t >= sec(2 * BAR) && e.pitch === 43)!.gain;
    expect(lightGain).toBeLessThan(emptyGain);
  });

  it('respects chordGain and does not run past the score end', () => {
    const loud = buildEvents(makeScore(), false, 0, { chords, chordGain: 0.9 }).events.filter((e) => e.chord);
    const soft = buildEvents(makeScore(), false, 0, { chords, chordGain: 0.3 }).events.filter((e) => e.chord);
    expect(loud[0].gain).toBeGreaterThan(soft[0].gain);
    const r = buildEvents(makeScore(), false, 0, { chords });
    for (const e of r.events) expect(e.t + e.dur).toBeLessThanOrEqual(sec(4 * BAR) + 1e-6);
    expect(r.endSec).toBeCloseTo(sec(4 * BAR), 6);
  });

  it('treats slash measures as empty even when notes exist', () => {
    const s = makeScore();
    s.meta.omrSlashMeasures = [{ index: 0, tick: 0, length: BAR }];
    const { events } = buildEvents(s, false, 0, { chords });
    const bar0 = events.filter((e) => e.chord && e.t < sec(BAR) && e.pitch === 48);
    expect(bar0).toHaveLength(4);
  });

  it('skips chords with no known shape', () => {
    const { events } = buildEvents(makeScore(), false, 0, { chords: [chord('???', 0, BAR)] });
    expect(events.filter((e) => e.chord)).toHaveLength(0);
  });
});
