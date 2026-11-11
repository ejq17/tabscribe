import { describe, it, expect } from 'vitest';
import { createEmptyScore, newNoteId, pulseTicks } from '../src/core';
import type { Score } from '../src/core';
import { strumChart } from '../src/chords/strum';
import type { ChordEvent } from '../src/chords';
import { buildEvents } from '../src/audio/player';

const PPQ = 480;

function scoreIn(num: number, den: number, bars = 2): Score {
  const s = createEmptyScore();
  s.timeSignatures = [{ tick: 0, numerator: num, denominator: den }];
  const barLen = (PPQ * 4 * num) / den;
  s.tracks.push({
    id: 't', name: 'g', program: 25, isGuitarTarget: true,
    notes: [{ id: newNoteId(), pitch: 72, start: 0, duration: PPQ, velocity: 100, voice: 0 }],
  } as Score['tracks'][number]);
  // make sure the score spans `bars` measures
  s.tracks[0].notes.push({ id: newNoteId(), pitch: 72, start: barLen * (bars - 1), duration: PPQ, velocity: 100, voice: 0 });
  return s;
}
const chord = (name: string, tick: number, duration: number): ChordEvent => ({ name, tick, duration, root: 0, quality: '', pitches: [], source: 'omr' });

describe('pulseTicks', () => {
  it('is never coarser than a quarter', () => {
    expect(pulseTicks(480, 2)).toBe(480);
    expect(pulseTicks(480, 4)).toBe(480);
    expect(pulseTicks(480, 8)).toBe(240);
  });
});

describe('2/2 behaves like 4/4', () => {
  it('strum chart has 4 cells per bar', () => {
    const lines = strumChart(scoreIn(2, 2), []);
    expect(lines[0].cells.length).toBe(8);
    expect(lines[0].cells.slice(0, 4).map((c) => c.tick)).toEqual([0, 480, 960, 1440]);
  });
  it('chord accompaniment strums 4 times in an empty bar', () => {
    const s = scoreIn(2, 2, 3); // bar 1 is empty
    const bar = PPQ * 4;
    const { events } = buildEvents(s, false, 0, { chords: [chord("C", 0, 3 * bar)] });
    const inBar1 = events.filter((e) => e.chord && e.pitch === 48 && e.t >= (bar / PPQ) * 0.5 - 1e-6 && e.t < ((2 * bar) / PPQ) * 0.5 - 1e-6);
    const ticks = new Set(inBar1.map((e) => Math.round(e.t * 1000)));
    expect(ticks.size).toBe(4);
  });
  it('metronome clicks 4 times per bar, accent on the downbeat only', () => {
    const { events } = buildEvents(scoreIn(2, 2), true);
    const clicks = events.filter((e) => e.click && e.t < 2 - 1e-6); // bar 0 = 2s at 120 bpm
    expect(clicks.length).toBe(4);
    expect(clicks.map((c) => c.click)).toEqual(['accent', 'normal', 'normal', 'normal']);
  });
});

describe('6/8 keeps the eighth-note pulse', () => {
  it('strum chart still has 6 cells per bar', () => {
    const lines = strumChart(scoreIn(6, 8), []);
    expect(lines[0].cells.length).toBe(12);
  });
  it('metronome clicks 6 times per bar', () => {
    const { events } = buildEvents(scoreIn(6, 8), true);
    const barSec = (PPQ * 3) / PPQ * 0.5;
    expect(events.filter((e) => e.click && e.t < barSec - 1e-6).length).toBe(6);
  });
});
