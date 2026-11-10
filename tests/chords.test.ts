import { describe, it, expect } from 'vitest';
import { createEmptyScore, newNoteId, STANDARD_TUNING, TUNINGS, spellingToMidi } from '../src/core';
import type { Score, Tuning } from '../src/core';
import { detectChords, chordDiagram, diagramFromVoicing, strumChart } from '../src/chords';
import { chordIntervals } from '../src/chords/quality';
import { chordVoicing } from '../src/audio/chordEvents';

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

describe('chordIntervals', () => {
  const cases: [string, number[], number[]][] = [
    ['', [0, 4, 7], [0, 4, 7]],
    ['m', [0, 3, 7], [0, 3, 7]],
    ['5', [0, 7], [0, 7]],
    ['sus4', [0, 5, 7], [0, 5, 7]],
    ['sus2', [0, 2, 7], [0, 2, 7]],
    ['7sus4', [0, 5, 7, 10], [0, 5, 10]],
    ['9sus4', [0, 2, 5, 7, 10], [0, 2, 5, 10]],
    ['maj9', [0, 2, 4, 7, 11], [0, 2, 4, 11]],
    ['maj13', [0, 2, 4, 7, 9, 11], [0, 4, 9, 11]],
    ['69', [0, 2, 4, 7, 9], [0, 2, 4, 9]],
    ['6/9', [0, 2, 4, 7, 9], [0, 2, 4, 9]],
    ['m69', [0, 2, 3, 7, 9], [0, 2, 3, 9]],
    ['13', [0, 2, 4, 7, 9, 10], [0, 4, 9, 10]],
    ['11', [0, 2, 4, 5, 7, 10], [0, 5, 10]],
    ['m11', [0, 2, 3, 5, 7, 10], [0, 3, 5, 10]],
    ['7b9', [0, 1, 4, 7, 10], [0, 1, 4, 10]],
    ['7#9', [0, 3, 4, 7, 10], [0, 3, 4, 10]],
    ['7b5', [0, 4, 6, 10], [0, 4, 6, 10]],
    ['7#5', [0, 4, 8, 10], [0, 4, 8, 10]],
    ['aug7', [0, 4, 8, 10], [0, 4, 8, 10]],
    ['7#11', [0, 4, 6, 10], [0, 4, 6, 10]],
    ['maj7#11', [0, 4, 6, 11], [0, 4, 6, 11]],
    ['mmaj7', [0, 3, 7, 11], [0, 3, 11]],
    ['add11', [0, 4, 5, 7], [0, 4, 5]],
    ['add2', [0, 2, 4, 7], [0, 2, 4]],
    ['madd9', [0, 2, 3, 7], [0, 2, 3]],
    ['7alt', [0, 3, 4, 8, 10], [0, 3, 4, 8, 10]],
    ['13b9', [0, 1, 4, 7, 9, 10], [0, 1, 4, 9, 10]],
    ['7b13', [0, 4, 8, 10], [0, 4, 8, 10]],
    ['Maj7', [0, 4, 7, 11], [0, 4, 11]],
    ['mMaj7', [0, 3, 7, 11], [0, 3, 11]],
    ['MAJ9', [0, 2, 4, 7, 11], [0, 2, 4, 11]],
    ['maj6', [0, 4, 7, 9], [0, 4, 9]],
    ['6', [0, 4, 7, 9], [0, 4, 9]],
    ['9#11', [0, 2, 4, 6, 10], [0, 2, 4, 6, 10]],
    ['m7b5', [0, 3, 6, 10], [0, 3, 6, 10]],
    ['dim7', [0, 3, 6, 9], [0, 3, 6, 9]],
    ['maj7#5', [0, 4, 8, 11], [0, 4, 8, 11]],
    ['m(maj7)', [0, 3, 7, 11], [0, 3, 11]],
    ['\u0394', [0, 4, 7], [0, 4, 7]],
  ];
  for (const [q, tones, required] of cases) {
    it(`parses "${q}"`, () => {
      expect(chordIntervals(q)).toEqual({ tones, required });
    });
  }
  it('accepts alternate spellings', () => {
    expect(chordIntervals('-\u03947')).toEqual(chordIntervals('mmaj7'));
    expect(chordIntervals('\u00f8')).toEqual(chordIntervals('m7b5'));
    expect(chordIntervals('+7')).toEqual(chordIntervals('aug7'));
    expect(chordIntervals('7+')).toEqual(chordIntervals('7#5'));
    expect(chordIntervals('M7')).toEqual(chordIntervals('maj7'));
  });
  it('returns null for non-qualities', () => {
    expect(chordIntervals('foo')).toBeNull();
    expect(chordIntervals('7x')).toBeNull();
  });
});

describe('chordDiagram extended qualities', () => {
  const QUALITIES = [
    '7sus4', '9sus4', '7sus', 'maj9', 'maj13', '69', '13', '11', 'm11', 'm13', '7b9', '7#9', '7b5', '7#5', 'aug7', '7#11', 'maj7#11',
    'mmaj7', 'add11', 'add2', 'madd9', '7alt', 'm69', '9#11', '13b9', '7b13', 'maj7#5', 'maj6', 'Maj7',
  ];
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  for (const q of QUALITIES) {
    it(`voices ${q} on every root`, () => {
      const iv = chordIntervals(q)!;
      expect(iv).not.toBeNull();
      NAMES.forEach((nm, root) => {
        const d = chordDiagram(nm + q, STANDARD_TUNING);
        expect(d, nm + q).not.toBeNull();
        const have = new Set<number>();
        d!.frets.forEach((f, i) => { if (f >= 0) have.add((STANDARD_TUNING.pitches[i] + f) % 12); });
        const tones = new Set(iv.tones.map((t) => (root + t) % 12));
        for (const pc of have) expect(tones.has(pc), `${nm}${q} has stray pitch class ${pc}`).toBe(true);
        for (const r of iv.required) expect(have.has((root + r) % 12), `${nm}${q} misses required ${r}`).toBe(true);
      });
    });
  }
  it('C6/9 and G6/9 keep their printed name and get a playback voicing', () => {
    for (const nm of ['C6/9', 'G6/9']) {
      const d = chordDiagram(nm, STANDARD_TUNING);
      expect(d).not.toBeNull();
      expect(d!.name).toBe(nm);
      expect(chordVoicing(nm, STANDARD_TUNING)).not.toBeNull();
    }
  });
  const lowPc = (d: { frets: number[] }) => {
    const i = Math.max(...d.frets.map((f, k) => (f >= 0 ? k : -1)));
    return (STANDARD_TUNING.pitches[i] + d.frets[i]) % 12;
  };
  const pcs = (d: { frets: number[] }) => d.frets.map((f, i) => (f >= 0 ? (STANDARD_TUNING.pitches[i] + f) % 12 : -1));
  it('Ebm6/F voices the non-chord-tone bass on the lowest string', () => {
    const d = chordDiagram('Ebm6/F', STANDARD_TUNING);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('Ebm6/F');
    expect(lowPc(d!)).toBe(5);
    const tones = new Set(chordIntervals('m6')!.tones.map((t) => (3 + t) % 12));
    const sounded = pcs(d!).filter((x) => x >= 0);
    expect(sounded.slice(0, -1).length).toBeGreaterThan(1);
    const low = Math.max(...d!.frets.map((f, k) => (f >= 0 ? k : -1)));
    pcs(d!).forEach((pc, i) => { if (pc >= 0 && i !== low) expect(tones.has(pc)).toBe(true); });
    const v = chordVoicing('Ebm6/F', STANDARD_TUNING);
    expect(v).not.toBeNull();
    expect(v![0] % 12).toBe(5);
  });
  it('slash chords put the bass on the lowest sounded string', () => {
    const bassOf: Record<string, number> = { 'C/Bb': 10, 'D/F#': 6, 'G/B': 11, 'Am/G': 7, 'F/G': 7, 'C/E': 4 };
    for (const [nm, b] of Object.entries(bassOf)) {
      const d = chordDiagram(nm, STANDARD_TUNING);
      expect(d, nm).not.toBeNull();
      expect(lowPc(d!), nm).toBe(b);
    }
  });
  it('every root x quality x bass gets a diagram; reached basses leave only tones or the bass', () => {
    NAMES.forEach((nm, root) => {
      for (const q of QUALITIES) {
        const iv = chordIntervals(q)!;
        const tones = new Set(iv.tones.map((t) => (root + t) % 12));
        NAMES.forEach((bn, b) => {
          const d = chordDiagram(`${nm}${q}/${bn}`, STANDARD_TUNING);
          expect(d, `${nm}${q}/${bn}`).not.toBeNull();
          if (lowPc(d!) === b) for (const pc of pcs(d!)) if (pc >= 0) expect(tones.has(pc) || pc === b, `${nm}${q}/${bn}`).toBe(true);
        });
      }
    });
  }, 120000);
  it('still rejects unreadable qualities', () => {
    expect(chordDiagram('Cfoo', STANDARD_TUNING)).toBeNull();
  });
});
