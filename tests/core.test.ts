import { describe, it, expect } from 'vitest';
import { createEmptyScore, measuresOf, ticksToSeconds, newNoteId } from '../src/core';
import { nameToMidi, midiToName, ticksToNoteValue } from '../src/core';

describe('core', () => {
  it('names', () => {
    expect(nameToMidi('C4')).toBe(60);
    expect(nameToMidi('Bb2')).toBe(46);
    expect(midiToName(61, true)).toBe('Db4');
  });
  it('measures', () => {
    const s = createEmptyScore();
    s.tracks.push({ id: 't', name: 't', program: 25, notes: [{ id: newNoteId(), pitch: 60, start: 0, duration: 480 * 9, velocity: 90, voice: 0 }] });
    expect(measuresOf(s).length).toBe(3);
    expect(ticksToSeconds(s, 480)).toBeCloseTo(0.5);
    expect(ticksToNoteValue(720, 480)).toEqual({ base: 4, dots: 1, triplet: false });
  });
});
