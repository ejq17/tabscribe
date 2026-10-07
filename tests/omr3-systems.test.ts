import { describe, it, expect } from 'vitest';
import { alignBarlines, assembleScore, regroupSystems } from '../src/omr/assemble';
import type { Binary, Notehead, PageResult, Staff, StaffSymbols, StemInfo } from '../src/omr/types';

const PPQ = 480;
const D = 10;

function mkStaff(top: number, system: number, partIndex: number, lowerOfGrand = false): Staff {
  const lines = [0, 1, 2, 3, 4].map((i) => top + i * D);
  return { lines, bands: [{ x: 0, ys: lines }], left: 20, right: 1000, staffSpace: D, lineThickness: 1, top, bottom: top + 4 * D, system, partIndex, lowerOfGrand };
}

function head(cx: number, cy: number, extra: Partial<Notehead> = {}): Notehead {
  return { cx, cy, x0: cx - 6, y0: cy - 5, x1: cx + 6, y1: cy + 5, hollow: false, stemId: -1, dots: 0, tiedFromPrevious: false, confidence: 0.9, step: 0, ...extra };
}

/** `bars` bars of four quarter notes on the middle line; bar k ends at x = base + (k + 1) * 280. `dropBar` omits one barline. */
function staffBars(top: number, bars: number, opts: { base?: number; dropBar?: number; extraBar?: number; clef?: 'treble' | 'bass'; eight?: boolean } = {}): StaffSymbols {
  const base = opts.base ?? 40;
  const stems: StemInfo[] = [];
  const heads: Notehead[] = [];
  const barlines: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 4; k++) {
      const x = base + 20 + b * 280 + k * 60;
      const id = stems.length;
      stems.push({ id, x: x + 6, top: top - 20, bottom: top + 2 * D, up: true, flags: 0, beamed: false });
      heads.push(head(x, top + 2 * D, { stemId: id }));
    }
    if (b !== opts.dropBar) barlines.push(base + (b + 1) * 280 - 10);
  }
  if (opts.extraBar !== undefined) barlines.push(base + opts.extraBar * 280 + 100);
  barlines.sort((a, b) => a - b);
  return { clef: opts.clef ?? 'treble', clefDetected: true, keyFifths: 0, musicStart: base, heads, stems, rests: [], barlines, warnings: [], staffRight: base + bars * 280 };
}

const TRANSFORM = { scale: 1, angle: 0, cx: 0, cy: 0, originalWidth: 1100, originalHeight: 1600 };

/** A page of systems; each system is a list of staves (voice, piano RH, piano LH ...). */
function pageOf(index: number, systems: { syms: StaffSymbols[]; grandPair?: boolean }[], clefOctaves?: number[]): PageResult {
  const staves: Staff[] = [];
  const symbols: StaffSymbols[] = [];
  const sysIdx: number[][] = [];
  let y = 100;
  systems.forEach((sys, si) => {
    const ids: number[] = [];
    sys.syms.forEach((sy, pi) => {
      const lower = !!sys.grandPair && pi === sys.syms.length - 1;
      ids.push(staves.length);
      staves.push(mkStaff(y, si, pi, lower));
      symbols.push(sy);
      y += 100;
    });
    sysIdx.push(ids);
    y += 150;
  });
  return { index, width: 1100, height: 1600, transform: TRANSFORM, staves, systems: sysIdx, symbols, warnings: [], clefOctaves };
}

const noteCount = (s: ReturnType<typeof assembleScore>) => s.tracks.reduce((n, t) => n + t.notes.length, 0);

describe('measures are counted per system, not per staff', () => {
  it('a voice + piano system (3 staves) with 3 bars is 3 measures', () => {
    const sys = { syms: [staffBars(100, 3), staffBars(200, 3), staffBars(300, 3, { clef: 'bass' })], grandPair: true };
    const s = assembleScore([pageOf(0, [sys])], PPQ);
    expect(s.meta.omrMeasures).toBe(3);
    // 3 staves x 3 bars x 4 notes
    expect(noteCount(s)).toBe(36);
    // voice -> own track; piano RH + LH share one track as voices 0 and 1
    expect(s.tracks).toHaveLength(2);
    const piano = s.tracks.find((t) => t.name === 'Piano')!;
    expect(new Set(piano.notes.map((n) => n.voice))).toEqual(new Set([0, 1]));
    const voice = s.tracks.find((t) => t.name !== 'Piano')!;
    expect(new Set(voice.notes.map((n) => n.voice))).toEqual(new Set([0]));
    // all tracks sit on one measure timeline
    const starts = (t: typeof piano) => [...new Set(t.notes.map((n) => n.start))].sort((a, b) => a - b);
    expect(starts(voice)).toEqual(starts(piano.notes.length ? { ...piano, notes: piano.notes.filter((n) => n.voice === 0) } : piano));
  });

  it('a 4-staff choir system (no grand pair) gives 4 tracks and counts the bars once', () => {
    const sys = { syms: [0, 1, 2, 3].map((k) => staffBars(100 + 100 * k, 2)) };
    const s = assembleScore([pageOf(0, [sys])], PPQ);
    expect(s.meta.omrMeasures).toBe(2);
    expect(s.tracks).toHaveLength(4);
    expect(noteCount(s)).toBe(32);
  });

  it('two systems on one page continue the numbering and the timeline', () => {
    const mk = (bars: number) => ({ syms: [staffBars(100, bars), staffBars(200, bars), staffBars(300, bars, { clef: 'bass' })], grandPair: true });
    const s = assembleScore([pageOf(0, [mk(2), mk(3)])], PPQ);
    expect(s.meta.omrMeasures).toBe(5);
    const voice = s.tracks.find((t) => t.name !== 'Piano')!;
    const last = Math.max(...voice.notes.map((n) => n.start));
    expect(last).toBe(4 * PPQ * 4 + 3 * PPQ); // last note of measure index 4 (starts at 16 beats), beat 4
  });

  it('numbering continues across pages', () => {
    const mk = (bars: number) => ({ syms: [staffBars(100, bars), staffBars(200, bars)], grandPair: true });
    const s = assembleScore([pageOf(0, [mk(2), mk(2)]), pageOf(1, [mk(3)])], PPQ);
    expect(s.meta.omrMeasures).toBe(7);
    const last = Math.max(...s.tracks.flatMap((t) => t.notes.map((n) => n.start)));
    expect(last).toBe(6 * PPQ * 4 + 3 * PPQ);
  });
});

describe('barline voting across the staves of a system', () => {
  it('restores a barline that one of three staves missed', () => {
    // staff 1 lost the barline after bar 1; its bar 1 and bar 2 notes must still land in separate measures
    const sys = { syms: [staffBars(100, 3), staffBars(200, 3, { dropBar: 1 }), staffBars(300, 3)], grandPair: false };
    const s = assembleScore([pageOf(0, [sys])], PPQ);
    expect(s.meta.omrMeasures).toBe(3);
    const t1 = s.tracks.find((t) => t.name === 'Staff 2')!;
    expect(t1.notes).toHaveLength(12);
    expect(new Set(t1.notes.map((n) => Math.floor(n.start / (4 * PPQ))))).toEqual(new Set([0, 1, 2]));
  });

  it('drops a spurious barline seen by only one of three staves', () => {
    const sys = { syms: [staffBars(100, 2), staffBars(200, 2, { extraBar: 0 }), staffBars(300, 2)], grandPair: false };
    const s = assembleScore([pageOf(0, [sys])], PPQ);
    expect(s.meta.omrMeasures).toBe(2);
  });

  it('two staves: union of the barlines (either could be right)', () => {
    const out = alignBarlines([staffBars(100, 3), staffBars(200, 3, { dropBar: 0 })], [D, D]);
    expect(out[0].barlines).toHaveLength(3);
    expect(out[1].barlines).toHaveLength(3);
  });

  it('keeps a staff\'s own x for barlines it has, within a small tolerance', () => {
    const a = staffBars(100, 2);
    const b = { ...staffBars(200, 2), barlines: staffBars(200, 2).barlines.map((x) => x + 3) };
    const out = alignBarlines([a, b], [D, D]);
    expect(out[0].barlines).toEqual(a.barlines);
    expect(out[1].barlines).toEqual(b.barlines);
  });
});

describe('system grouping from the page image', () => {
  /** Binary page with staves and a vertical connector (system barline) at x = left over the given rows. */
  function bin(): Binary {
    return { width: 400, height: 900, data: new Uint8Array(400 * 900) };
  }
  const draw = (b: Binary, x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) b.data[y * b.width + x] = 1;
  };
  const stavesAt = (tops: number[]) => tops.map((t, i) => ({ ...mkStaff(t, i, 0), left: 100, right: 380 }));

  it('joins any number of staves that share a system barline, even with a large gap (lyrics between)', () => {
    const staves = stavesAt([100, 230, 330, 600, 730, 830]);
    const b = bin();
    draw(b, 100, 100, 370); // system 1: three staves
    draw(b, 100, 600, 870); // system 2
    const systems = regroupSystems(b, staves);
    expect(systems).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(staves.map((s) => s.partIndex)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(staves.map((s) => s.system)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('staves with no connector stay separate systems', () => {
    const staves = stavesAt([100, 230, 360]);
    const systems = regroupSystems(bin(), staves);
    expect(systems).toEqual([[0], [1], [2]]);
  });

  it('marks the lower staff of a two-staff system as the grand-staff bass staff', () => {
    const staves = stavesAt([100, 180]);
    const b = bin();
    draw(b, 100, 100, 220);
    regroupSystems(b, staves);
    expect(staves.map((s) => s.lowerOfGrand)).toEqual([false, true]);
  });

  it('marks only the lowest pair of a three-staff system as grand when a brace spans just that pair', () => {
    const staves = stavesAt([100, 230, 330]);
    const b = bin();
    draw(b, 100, 100, 370);
    // brace left of the piano pair: ink in every row of the gap between staves 1 and 2
    for (let y = 270; y <= 330; y++) b.data[y * b.width + 92] = 1;
    regroupSystems(b, staves);
    expect(staves.map((s) => s.lowerOfGrand)).toEqual([false, false, true]);
  });
});

describe('octave: Score pitch is the sounding pitch', () => {
  const sys = () => ({ syms: [staffBars(100, 1)] });
  const firstPitch = (s: ReturnType<typeof assembleScore>) => s.tracks[0].notes[0].pitch;
  it('default (concert) reads treble clefs as written: middle line B4 = 71', () => {
    expect(firstPitch(assembleScore([pageOf(0, [sys()])], PPQ))).toBe(71);
  });
  it('instrument "guitar" shifts treble staves down an octave (B3 = 59) and fixes the spelling octave', () => {
    const s = assembleScore([pageOf(0, [sys()])], PPQ, { instrument: 'guitar' });
    expect(firstPitch(s)).toBe(59);
    expect(s.tracks[0].notes[0].spelling?.octave).toBe(3);
  });
  it('a detected "8" under the treble clef shifts that part down an octave without any option', () => {
    const s = assembleScore([pageOf(0, [sys()], [-1])], PPQ);
    expect(firstPitch(s)).toBe(59);
  });
  it('a printed 8 plus instrument "guitar" is shifted once, not twice', () => {
    const s = assembleScore([pageOf(0, [sys()], [-1])], PPQ, { instrument: 'guitar' });
    expect(firstPitch(s)).toBe(59);
  });
  it('instrument "guitar" never shifts the treble staff of a piano grand staff (or any system with a bass clef)', () => {
    const grand = { syms: [staffBars(100, 1), staffBars(200, 1, { clef: 'bass' })], grandPair: true };
    const g = assembleScore([pageOf(0, [grand])], PPQ, { instrument: 'guitar' });
    const piano = g.tracks.find((t) => t.name === 'Piano')!;
    expect(piano.notes.find((n) => n.voice === 0)!.pitch).toBe(71);
    // a treble staff sharing a system with a bass staff (no brace) is not shifted either
    const mixed = { syms: [staffBars(100, 1), staffBars(200, 1, { clef: 'bass' })] };
    const m = assembleScore([pageOf(0, [mixed])], PPQ, { instrument: 'guitar' });
    expect(m.tracks[0].notes[0].pitch).toBe(71);
  });
  it('bass clef staves are never shifted', () => {
    const bass = { syms: [staffBars(100, 1, { clef: 'bass' })] };
    expect(firstPitch(assembleScore([pageOf(0, [bass])], PPQ, { instrument: 'guitar' }))).toBe(firstPitch(assembleScore([pageOf(0, [bass])], PPQ)));
  });
  it('only the part with the "8" shifts (tenor in an SATB system)', () => {
    const four = { syms: [0, 1, 2, 3].map((k) => staffBars(100 + 100 * k, 1)) };
    const s = assembleScore([pageOf(0, [four], [0, 0, -1, 0])], PPQ);
    const pitches = s.tracks.map((t) => t.notes[0].pitch);
    expect(pitches).toEqual([71, 71, 59, 71]);
  });
});
