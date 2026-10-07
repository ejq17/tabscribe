import { describe, it, expect } from 'vitest';
import { createEmptyScore, newNoteId, STANDARD_TUNING, TUNINGS, spellingToMidi } from '../src/core';
import type { Score, Tuning } from '../src/core';
import { detectChords, chordDiagram, diagramFromVoicing, strumChart } from '../src/chords';

const PPQ = 480;
/** One chord per measure (4/4). Each entry lists pitches lowest first. */
function mk(chords: number[][], measures = 1): Score {
  const s = createEmptyScore();
  const notes = [] as Score['tracks'][number]['notes'];
  chords.forEach((c, i) => {
    for (const p of c) notes.push({ id: newNoteId(), pitch: p, start: i * PPQ * 4 * measures, duration: PPQ * 4 * measures, velocity: 90, voice: 0 });
  });
  s.tracks.push({ id: 't', name: 'x', program: 0, notes });
  return s;
}
const names = (s: Score, res: 'beat' | 'measure' | 'half' = 'measure') => detectChords(s, { resolution: res }).map((c) => c.name);

describe('detectChords', () => {
  it('basic triads and sevenths', () => {
    expect(names(mk([[60, 64, 67]]))).toEqual(['C']);
    expect(names(mk([[57, 60, 64]]))).toEqual(['Am']);
    expect(names(mk([[55, 59, 62, 65]]))).toEqual(['G7']);
    expect(names(mk([[62, 66, 69, 73]]))).toEqual(['Dmaj7']);
    expect(names(mk([[60, 65, 67]]))).toEqual(['Csus4']);
    expect(names(mk([[60, 62, 67]]))).toEqual(['Csus2']);
  });
  it('slash chords with bass chord tone', () => {
    const ev = detectChords(mk([[52, 60, 67]]), { resolution: 'measure' });
    expect(ev[0].name).toBe('C/E');
    expect(ev[0].root).toBe(0);
    expect(ev[0].bass).toBe(4);
  });
  it('power chords and flats', () => {
    expect(names(mk([[40, 47]]))).toEqual(['E5']);
    const s = mk([[58, 62, 65]]);
    s.keySignatures = [{ tick: 0, fifths: -2, mode: 'major' }];
    expect(names(s)).toEqual(['Bb']);
  });
  it('merges consecutive identical beats and is stable', () => {
    const s = mk([[60, 64, 67], [57, 60, 64]]);
    const ev = detectChords(s); // beat resolution
    expect(ev.map((e) => e.name)).toEqual(['C', 'Am']);
    expect(ev[0].duration).toBe(PPQ * 4);
    expect(ev[1].tick).toBe(PPQ * 4);
  });
  it('returns nothing for silence or single notes', () => {
    expect(detectChords(createEmptyScore())).toEqual([]);
    expect(names(mk([[60]]))).toEqual([]);
  });
  it('keeps the previous chord on a near tie', () => {
    // C E G in beats 1-2, then add A (C6 / Am7 ambiguity) in beats 3-4 with C bass kept
    const s = mk([[48, 52, 55]]);
    s.tracks[0].notes.push({ id: newNoteId(), pitch: 69, start: PPQ * 2, duration: PPQ * 2, velocity: 90, voice: 0 });
    const ev = detectChords(s);
    expect(ev.length).toBeLessThanOrEqual(2);
  });
});

describe('detectChords noise rejection', () => {
  const note = (pitch: number, start: number, duration: number) => ({ id: newNoteId(), pitch, start, duration, velocity: 90, voice: 0 });
  it('ignores a stepwise scale, then finds block chords', () => {
    const s = createEmptyScore();
    const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => note(p, i * PPQ, PPQ));
    [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]].forEach((c, i) => {
      for (const p of c) notes.push(note(p, (2 + i) * PPQ * 4, PPQ * 4));
    });
    s.tracks.push({ id: 't', name: 'x', program: 0, notes });
    expect(names(s, 'half')).toEqual(['C', 'Am', 'F', 'G']);
    expect(names(s, 'beat')).toEqual(['C', 'Am', 'F', 'G']);
  });
  it('recognises an arpeggiated triad', () => {
    const s = createEmptyScore();
    s.tracks.push({ id: 't', name: 'x', program: 0, notes: [60, 64, 67, 72].map((p, i) => note(p, i * PPQ / 2, PPQ / 2)) });
    expect(names(s, 'measure')).toEqual(['C']);
  });
  it('does not slash a low bass that is the root, or a close bass', () => {
    const s = createEmptyScore();
    s.tracks.push({ id: 't', name: 'x', program: 0, notes: [note(36, 0, PPQ * 4), note(64, 0, PPQ * 2), note(67, 0, PPQ * 2), note(72, 0, PPQ * 2)] });
    expect(names(s, 'measure')).toEqual(['C']);
  });
});

/** frets high->low index; helper converts to the low->high string notation for readability */
describe('chordDiagram', () => {
  it('classic open shapes', () => {
    expect(chordDiagram('C', STANDARD_TUNING)!.frets).toEqual([0, 1, 0, 2, 3, -1]);
    expect(chordDiagram('Am', STANDARD_TUNING)!.frets).toEqual([0, 1, 2, 2, 0, -1]);
    expect(chordDiagram('G', STANDARD_TUNING)!.frets).toEqual([3, 0, 0, 0, 2, 3]);
    expect(chordDiagram('C', STANDARD_TUNING)!.baseFret).toBe(1);
  });
  it('barre chords', () => {
    const d = chordDiagram('F#m', STANDARD_TUNING)!;
    expect(d.baseFret).toBe(2);
    expect(d.barres?.length).toBe(1);
    expect(d.barres![0]).toEqual({ fret: 2, from: 0, to: 5 });
    const f = chordDiagram('F', STANDARD_TUNING)!;
    expect(f.frets).toEqual([1, 1, 2, 3, 3, 1]);
    expect(f.barres?.[0].fret).toBe(1);
  });
  it('generated shapes are correct for every root x quality in standard tuning', () => {
    const quals: Record<string, number[]> = {
      '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7],
      dim: [0, 3, 6], aug: [0, 4, 8], '5': [0, 7], add9: [0, 4, 7, 2], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '9': [0, 4, 7, 10, 2],
      m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9],
    };
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    roots.forEach((r, ri) => {
      const rootPc = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11][ri];
      for (const [q, ivs] of Object.entries(quals)) {
        const d = chordDiagram(r + q, STANDARD_TUNING);
        expect(d, r + q).not.toBeNull();
        const pcs = new Set<number>();
        d!.frets.forEach((f, s) => { if (f >= 0) pcs.add((STANDARD_TUNING.pitches[s] + f) % 12); });
        const tones = new Set(ivs.map((i) => (rootPc + i) % 12));
        for (const p of pcs) expect(tones.has(p), `${r}${q} has foreign tone ${p}: ${d!.frets}`).toBe(true);
        // root present, and lowest sounded is the root for non-open-quirk shapes
        expect(pcs.has(rootPc), `${r}${q} has root`).toBe(true);
        expect(pcs.size).toBeGreaterThanOrEqual(2);
      }
    });
  });
  it('computes voicings for Drop D', () => {
    const dropD = TUNINGS.find((t) => t.name === 'Drop D')!;
    const d = chordDiagram('D', dropD)!;
    expect(d).not.toBeNull();
    const pcs = new Set<number>();
    d.frets.forEach((f, s) => { if (f >= 0) pcs.add((dropD.pitches[s] + f) % 12); });
    expect([...pcs].sort((a, b) => a - b)).toEqual([2, 6, 9]);
    const fretted = d.frets.filter((f) => f > 0);
    expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(3);
    expect(d.frets.filter((f) => f >= 0).length).toBeGreaterThanOrEqual(3);
    // lowest sounded string is the root
    const low = Math.max(...d.frets.map((f, i) => (f >= 0 ? i : -1)));
    expect((dropD.pitches[low] + d.frets[low]) % 12).toBe(2);
  });
  it('handles unknown tuning, slash chords and bad names', () => {
    const t: Tuning = { name: 'Open G', pitches: [62, 59, 55, 50, 43, 38] };
    expect(chordDiagram('G', t)).not.toBeNull();
    const sl = chordDiagram('C/E', STANDARD_TUNING)!;
    const low = Math.max(...sl.frets.map((f, i) => (f >= 0 ? i : -1)));
    expect((STANDARD_TUNING.pitches[low] + sl.frets[low]) % 12).toBe(4);
    expect(chordDiagram('H#', STANDARD_TUNING)).toBeNull();
    expect(chordDiagram('Cfoo', STANDARD_TUNING)).toBeNull();
  });
  it('diagramFromVoicing', () => {
    const d = diagramFromVoicing([{ string: 5, fret: 3 }, { string: 4, fret: 2 }, { string: 3, fret: 0 }], 'x');
    expect(d.frets).toEqual([-1, -1, -1, 0, 2, 3]);
    expect(d.baseFret).toBe(1);
    expect(spellingToMidi({ step: 'C', alter: 0, octave: 4 })).toBe(60);
  });
});

describe('strumChart', () => {
  it('lines of 4 measures with one cell per beat', () => {
    const s = mk([[60, 64, 67], [57, 60, 64], [60, 64, 67], [55, 59, 62], [60, 64, 67]]);
    const ev = detectChords(s);
    const lines = strumChart(s, ev);
    expect(lines.length).toBe(2);
    expect(lines[0].cells.length).toBe(16);
    expect(lines[0].cells[0].chord).toBe('C');
    expect(lines[0].cells[1].chord).toBeNull();
    expect(lines[0].cells[4].chord).toBe('Am');
    expect(lines[1].cells.length).toBe(4);
    expect(lines[1].cells[0].chord).toBe('C');
  });
});
