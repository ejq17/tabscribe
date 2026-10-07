import { describe, it, expect } from 'vitest';
import { assembleScore } from '../src/omr/assemble';
import { clusterHeads, layoutMeasure, staffLayout, snapStandardTicks, type RhythmEvent } from '../src/omr/rhythm';
import type { Notehead, PageResult, RestSym, Staff, StaffSymbols, StemInfo } from '../src/omr/types';

const PPQ = 480;
const D = 10;

function mkStaff(top: number, system: number): Staff {
  const lines = [0, 1, 2, 3, 4].map((i) => top + i * D);
  return {
    lines,
    bands: [{ x: 0, ys: lines }],
    left: 20,
    right: 1000,
    staffSpace: D,
    lineThickness: 1,
    top,
    bottom: top + 4 * D,
    system,
    partIndex: 0,
    lowerOfGrand: false,
  };
}

function head(cx: number, cy: number, extra: Partial<Notehead> = {}): Notehead {
  return { cx, cy, x0: cx - 6, y0: cy - 5, x1: cx + 6, y1: cy + 5, hollow: false, stemId: -1, dots: 0, tiedFromPrevious: false, confidence: 0.9, step: 0, ...extra };
}

/** Quarter notes (stemmed, filled) at the given x positions on the middle line (B4). */
function quarters(top: number, xs: number[], stems: StemInfo[]): Notehead[] {
  return xs.map((x) => {
    const id = stems.length;
    stems.push({ id, x: x + 6, top: top - 20, bottom: top + 2 * D, up: true, flags: 0, beamed: false });
    return head(x, top + 2 * D, { stemId: id });
  });
}

function sym(p: Partial<StaffSymbols>): StaffSymbols {
  return { clef: 'treble', clefDetected: true, keyFifths: 0, musicStart: 40, heads: [], stems: [], rests: [], barlines: [], warnings: [], staffRight: 1000, ...p };
}

function page(staffTops: number[], symbols: StaffSymbols[]): PageResult {
  return {
    index: 0,
    width: 1100,
    height: 1600,
    transform: { scale: 1, angle: 0, cx: 0, cy: 0, originalWidth: 1100, originalHeight: 1600 },
    staves: staffTops.map((t, i) => mkStaff(t, i)),
    systems: staffTops.map((_, i) => [i]),
    symbols,
    warnings: [],
  };
}

/** One system of N bars of 3 quarter notes each (bars end at x = 300, 560, ...). */
function threeQuarterBars(top: number, nBars: number, extra: Partial<StaffSymbols> = {}): StaffSymbols {
  const stems: StemInfo[] = [];
  const xs: number[] = [];
  const barlines: number[] = [];
  for (let b = 0; b < nBars; b++) {
    for (let k = 0; k < 3; k++) xs.push(60 + b * 260 + k * 70);
    barlines.push(60 + b * 260 + 230);
  }
  const heads = quarters(top, xs, stems);
  return sym({ heads, stems, barlines, ...extra });
}

const noteDurations = (s: ReturnType<typeof assembleScore>) => s.tracks.flatMap((t) => t.notes.map((n) => n.duration));

describe('class 10: stacked chord is one onset', () => {
  it('merges heads split into two columns by an adjacent roll squiggle and collapses duplicate staff positions', () => {
    const stems: StemInfo[] = [
      { id: 0, x: 1235, top: 1758, bottom: 1835, up: false, flags: 0, beamed: false }, // the squiggle, read as a stem
      { id: 1, x: 1262, top: 1732, bottom: 1825, up: true, flags: 0, beamed: false },
    ];
    const hs = [
      head(1228.5, 1775.5, { hollow: true, stemId: 0 }),
      head(1228.5, 1787.5, { hollow: true, stemId: 0 }),
      head(1228.5, 1800.5, { hollow: true, stemId: 0 }),
      head(1243.5, 1769.5, { hollow: true, stemId: 0 }),
      head(1255, 1763, { hollow: true, stemId: 1, dots: 1 }),
      head(1255, 1800, { hollow: true, stemId: 1, dots: 1 }),
      head(1255, 1825, { hollow: true, stemId: 1, dots: 1 }),
      head(1256.5, 1773, { hollow: true, stemId: 1, dots: 2 }),
    ];
    const cl = clusterHeads(hs, stems, 12.375, PPQ);
    expect(cl).toHaveLength(1);
    // one head per staff position (five distinct pitches), all with the dotted-half duration
    expect(cl[0].heads.length).toBe(5);
    expect(new Set(cl[0].durations).size).toBe(1);
    expect(cl[0].durations[0]).toBe(PPQ * 3);
  });

  it('does not merge consecutive notes of a run', () => {
    const stems: StemInfo[] = [];
    const hs = quarters(100, [60, 75, 90], stems).map((h, i) => ({ ...h, cy: 120 - i * 5 }));
    // 15 px apart at d = 10 is 1.5 d: separate onsets
    expect(clusterHeads(hs, stems, D, PPQ)).toHaveLength(3);
  });
});

describe('class 8: principled rhythm repair', () => {
  const q = (n: number): RhythmEvent[] => {
    const stems: StemInfo[] = [];
    const hs = quarters(100, Array.from({ length: n }, (_, i) => 60 + i * 70), stems);
    return clusterHeads(hs, stems, D, PPQ).map((c) => ({ kind: 'cluster', x: c.x, cluster: c }));
  };

  it('never invents non-standard durations for a 3/4 bar laid out as 4/4', () => {
    const lay = layoutMeasure(q(3), PPQ * 4, PPQ, false);
    expect(lay.underfull).toBe(true);
    expect(lay.scaled).toBe(false);
    for (const p of lay.placed) expect(p.advance).toBe(PPQ); // quarters stay quarters, not 1.25 beats
  });

  it('snaps an over-long bar to standard durations that fill it', () => {
    // a dotted half read as a whole note in 3/4
    const stems: StemInfo[] = [];
    const h = head(60, 120, { hollow: true });
    const ev: RhythmEvent[] = [{ kind: 'cluster', x: 60, cluster: clusterHeads([h], stems, D, PPQ)[0] }];
    const lay = layoutMeasure(ev, PPQ * 3, PPQ, false);
    expect(lay.snapped).toBe(true);
    expect(lay.placed[0].advance).toBe(PPQ * 3);
    expect(lay.mismatch).toBe(true);
  });

  it('only ever emits standard durations when snapping several events', () => {
    const stems: StemInfo[] = [];
    const hs = quarters(100, [60, 130, 200, 270], stems);
    hs[2].hollow = true; // quarter, quarter, half, quarter = 5 beats in 4/4
    const ev: RhythmEvent[] = clusterHeads(hs, stems, D, PPQ).map((c) => ({ kind: 'cluster', x: c.x, cluster: c }));
    const lay = layoutMeasure(ev, PPQ * 4, PPQ, false);
    const sum = lay.placed.reduce((s, p) => s + p.advance, 0);
    expect(sum).toBe(PPQ * 4);
    for (const p of lay.placed) expect(snapStandardTicks(p.advance, PPQ)).toBe(p.advance);
  });

  it('infers 3/4 when consecutive bars all add up to 3 beats, with a warning', () => {
    const top = 100;
    const s = assembleScore([page([top], [threeQuarterBars(top, 6)])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ tick: 0, numerator: 3, denominator: 4 });
    expect(s.meta.warnings?.some((w) => /inferred as 3\/4/.test(w))).toBe(true);
    expect(noteDurations(s).every((d) => d === PPQ)).toBe(true);
    expect(s.meta.omrMeasures).toBe(6);
  });

  it('overrides a digit-read printed signature that disagrees with the bar lengths, with a warning', () => {
    const top = 100;
    const sy = threeQuarterBars(top, 6, { timeSig: { numerator: 2, denominator: 4 } });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(s.meta.warnings?.some((w) => /Printed time signature 2\/4 disagrees with bar lengths; using 3\/4/.test(w))).toBe(true);
  });

  it('caps note confidence at 0.7 in a system whose printed signature was overridden', () => {
    const top = 100;
    const sy = threeQuarterBars(top, 6, { timeSig: { numerator: 2, denominator: 4 } });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(Math.max(...s.tracks.flatMap((t) => t.notes.map((n) => n.confidence ?? 1)))).toBeLessThanOrEqual(0.7);
  });

  it('does not override a printed signature on thin evidence (3 agreeing bars)', () => {
    const top = 100;
    // 4 bars: the last one is excluded, leaving 3 agreeing bars < the 4 needed to overrule a printed signature
    const sy = threeQuarterBars(top, 4, { timeSig: { numerator: 2, denominator: 4 } });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 2, denominator: 4 });
    expect(s.meta.warnings?.some((w) => /disagrees/.test(w))).toBe(false);
  });

  it('never overrides a common-time (4/4) sign', () => {
    const top = 100;
    const sy = threeQuarterBars(top, 6, { timeSig: { numerator: 4, denominator: 4 } });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(s.meta.warnings?.some((w) => /disagrees/.test(w))).toBe(false);
  });

  it('accepts a short piece whose two full bars agree, with a low-confidence warning', () => {
    const top = 100;
    // pickup bar + 2 full 3/4 bars + final bar: only two full bars, below the usual three
    const sy = threeQuarterBars(top, 4, { timeSigUnreadable: true });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(s.meta.warnings?.some((w) => /low confidence/.test(w))).toBe(true);
  });

  it('keeps a printed time signature instead of inferring', () => {
    const top = 100;
    const sy = threeQuarterBars(top, 4, { timeSig: { numerator: 4, denominator: 4 } });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(noteDurations(s).every((d) => [PPQ, 2 * PPQ].includes(d) || d > 0)).toBe(true);
    expect(s.meta.warnings?.some((w) => /inferred/.test(w))).toBe(false);
  });
});

describe('class 4: courtesy signatures at the end of a staff', () => {
  const junk = (x: number): RestSym[] => [
    { kind: 'eighth', x0: x, y0: 100, x1: x + 10, y1: 120, dots: 0 },
    { kind: 'eighth', x0: x + 20, y0: 100, x1: x + 30, y1: 120, dots: 0 },
  ];

  it('does not turn trailing signature junk after the last barline into a measure (heuristic)', () => {
    const top = 100;
    const base = threeQuarterBars(top, 3);
    // last barline at 60+2*260+230 = 810; staff ends at 1000 with rest-like fragments from the courtesy glyphs
    const sy = { ...base, rests: junk(830), staffRight: 900 };
    const lay = staffLayout(sy, sy.stems, D, PPQ);
    expect(lay.measures).toHaveLength(3);
    expect(lay.trailingCourtesy).toBe(true);
  });

  it('keeps a real unterminated last measure that has notes', () => {
    const top = 100;
    const base = threeQuarterBars(top, 2);
    const stems = base.stems.slice();
    const extra = quarters(top, [600, 670], stems);
    const sy = { ...base, stems, heads: [...base.heads, ...extra], staffRight: 1000 };
    expect(staffLayout(sy, sy.stems, D, PPQ).measures).toHaveLength(3);
  });

  it('carries a declared courtesy time/key signature to the next system and applies it from its first measure', () => {
    const t1 = 100;
    const t2 = 300;
    const s1 = threeQuarterBars(t1, 3, {
      timeSig: { numerator: 4, denominator: 4 },
      rests: junk(880),
      signatureChanges: [{ barline: 2, x0: 860, x1: 940, timeSig: { numerator: 3, denominator: 4 }, keyFifths: -3 }],
    });
    // system 1 is really 4/4 with 4 quarters per bar, then 3/4 follows
    const stems1: StemInfo[] = [];
    const xs: number[] = [];
    for (let b = 0; b < 3; b++) for (let k = 0; k < 4; k++) xs.push(60 + b * 260 + k * 55);
    s1.heads = quarters(t1, xs, stems1);
    s1.stems = stems1;
    s1.barlines = [60 + 230, 60 + 260 + 230, 60 + 520 + 230];
    const s2 = threeQuarterBars(t2, 3);
    const pr = page([t1, t2], [s1, s2]);
    const s = assembleScore([pr], PPQ);
    expect(s.meta.omrMeasures).toBe(6); // 3 + 3: the courtesy cell is not a measure
    expect(s.timeSignatures.map((t) => [t.tick, t.numerator, t.denominator])).toEqual([[0, 4, 4], [3 * 4 * PPQ, 3, 4]]);
    expect(s.keySignatures.some((k) => k.tick === 3 * 4 * PPQ && k.fifths === -3)).toBe(true);
    // second system: 9 quarter notes of one beat each, none stretched
    const dur2 = s.tracks[0].notes.filter((n) => n.start >= 3 * 4 * PPQ).map((n) => n.duration);
    expect(dur2).toHaveLength(9);
    expect(dur2.every((d) => d === PPQ)).toBe(true);
  });

  it('applies a mid-staff change after a double barline from the following measure', () => {
    const top = 100;
    const stems: StemInfo[] = [];
    const xs: number[] = [];
    for (let b = 0; b < 2; b++) for (let k = 0; k < 4; k++) xs.push(60 + b * 260 + k * 55);
    for (let b = 2; b < 4; b++) for (let k = 0; k < 3; k++) xs.push(60 + b * 260 + k * 70);
    const sy = sym({
      heads: quarters(top, xs, stems),
      stems,
      barlines: [290, 550, 810, 1070].map((x) => x),
      staffRight: 1200,
      timeSig: { numerator: 4, denominator: 4 },
      signatureChanges: [{ barline: 1, x0: 556, x1: 600, timeSig: { numerator: 3, denominator: 4 } }],
    });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.timeSignatures.map((t) => [t.tick, t.numerator])).toEqual([[0, 4], [2 * 4 * PPQ, 3]]);
  });
});

describe('class 9: tie across a line break', () => {
  it('flags the first note of the next system as tied from the previous when the staff ends with a tie arc', () => {
    const t1 = 100;
    const t2 = 300;
    const mk = (top: number, tie: boolean): StaffSymbols => {
      const s = threeQuarterBars(top, 1, { timeSig: { numerator: 3, denominator: 4 } });
      if (tie) {
        const last = s.heads[2];
        s.tieOut = last;
        s.tieOuts = [last];
      }
      return s;
    };
    const s = assembleScore([page([t1, t2], [mk(t1, true), mk(t2, false)])], PPQ);
    const notes = s.tracks[0].notes;
    expect(notes).toHaveLength(6);
    expect(notes[3].tiedFromPrevious).toBe(true);
    expect(notes[4].tiedFromPrevious).toBeUndefined();
  });

  it('matches by staff position when the pitch spelling differs, and warns when the partner is missing', () => {
    const t1 = 100;
    const t2 = 300;
    const a = threeQuarterBars(t1, 1, { timeSig: { numerator: 3, denominator: 4 } });
    a.tieOut = a.heads[2];
    const b = threeQuarterBars(t2, 1);
    b.heads[0].cy -= 2 * D; // different pitch: no match
    const s = assembleScore([page([t1, t2], [a, b])], PPQ);
    expect(s.tracks[0].notes[3].tiedFromPrevious).toBeUndefined();
    expect(s.meta.warnings?.some((w) => /tie\(s\) running off the end/.test(w))).toBe(true);
  });
});

describe('slash-notation bars', () => {
  it('emits slash bars as a measure list in meta.omrSlashMeasures (no notes, no skipped-warning)', () => {
    const top = 100;
    const stems: StemInfo[] = [];
    const heads = quarters(top, [60, 130, 200], stems); // bar 1: notes
    const slashes = [{ cx: 400, cy: top + 20 }, { cx: 450, cy: top + 20 }, { cx: 500, cy: top + 20 }]; // bar 2: slashes
    const sy = sym({ heads, stems, barlines: [290, 550], timeSig: { numerator: 3, denominator: 4 }, slashes, staffRight: 1000 });
    const s = assembleScore([page([top], [sy])], PPQ);
    expect(s.meta.omrSlashMeasures).toEqual([{ index: 1, tick: 3 * PPQ, length: 3 * PPQ }]);
    expect(s.tracks[0].notes).toHaveLength(3);
    expect(s.meta.warnings?.some((w) => /skipped/.test(w))).toBe(false);
  });
});
