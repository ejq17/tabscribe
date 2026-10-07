import { createEmptyScore, newNoteId, type Note, type Score, type Track } from '../core';
import { preprocess, toOriginal } from './preprocess';
import { detectStaves, lineY } from './staves';
import { analyzeStaff } from './symbols';
import { pitchMeasure } from './pitch';
import { layoutMeasure, quantizeTicks, rawMeasureTotal, snapStandardTicks, staffLayout, type RhythmEvent, type SigChange } from './rhythm';
import { chordOcrUnavailable, detectChordLabels, disposeChordOcr, resetChordOcrState, type ChordLabel } from './chordtext';
import type { Binary, OmrBox, OmrInstrument, PageResult, RawImage, RecognizeOptions, Staff, StaffSymbols } from './types';

/** Run preprocessing, staff detection and symbol analysis on one page image. Pure; no DOM. */
export function analyzePage(img: RawImage, index: number, opts: RecognizeOptions = {}): PageResult {
  const defaultClef = opts.defaultClef ?? 'treble';
  const warnings: string[] = [];
  const pre = preprocess(img);
  const staves = detectStaves(pre.binary);
  const systems = regroupSystems(pre.binary, staves);
  const symbols: StaffSymbols[] = [];
  if (staves.length === 0) warnings.push(`Page ${index + 1}: no staves found.`);
  staves.forEach((staff, i) => {
    // clip the region at the midpoint to vertical neighbours
    let y0 = -Infinity;
    let y1 = Infinity;
    let limitTop = -Infinity;
    let limitBottom = Infinity;
    for (let j = 0; j < staves.length; j++) {
      if (j === i) continue;
      const o = staves[j];
      if (o.right < staff.left || o.left > staff.right) continue;
      if (o.bottom <= staff.top) {
        y0 = Math.max(y0, (o.bottom + staff.top) / 2);
        limitTop = Math.max(limitTop, o.bottom + 0.6 * o.staffSpace);
      } else if (o.top >= staff.bottom) {
        y1 = Math.min(y1, (staff.bottom + o.top) / 2);
        limitBottom = Math.min(limitBottom, o.top - 0.6 * o.staffSpace);
      }
    }
    const sym = analyzeStaff(pre.binary, staff, { defaultClef, y0, y1, limitTop, limitBottom });
    for (const w of sym.warnings) warnings.push(`Page ${index + 1}, staff ${i + 1}: ${w}`);
    symbols.push(sym);
    opts.onProgress?.({ stage: 'Reading notation', fraction: (i + 1) / staves.length, page: index });
  });
  assignTuplets(staves, symbols);
  const clefOctaves = staves.map((st, i) => (symbols[i].clef === 'treble' && hasClefEight(pre.binary, st) ? -1 : 0));
  return {
    index,
    width: pre.binary.width,
    height: pre.binary.height,
    transform: pre.transform,
    staves,
    systems,
    symbols,
    warnings,
    binary: pre.binary,
    grey: pre.grey,
    clefOctaves,
  };
}

/** Maximum fraction of ink in a column of the given box (columns x0..x1, rows y0..y1). */
function columnInk(b: Binary, x0: number, x1: number, y0: number, y1: number): number {
  let best = 0;
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(b.height - 1, Math.ceil(y1));
  for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(b.width - 1, Math.ceil(x1)); x++) {
    let c = 0;
    for (let y = ya; y <= yb; y++) if (b.data[y * b.width + x]) c++;
    if (yb >= ya) best = Math.max(best, c / (yb - ya + 1));
  }
  return best;
}

/** Fraction of rows in y0..y1 that have any ink in columns x0..x1 (a brace is continuous vertically, even where thin). */
function rowInk(b: Binary, x0: number, x1: number, y0: number, y1: number): number {
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(b.height - 1, Math.ceil(y1));
  let rows = 0;
  for (let y = ya; y <= yb; y++) {
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(b.width - 1, Math.ceil(x1)); x++) {
      if (b.data[y * b.width + x]) {
        rows++;
        break;
      }
    }
  }
  return yb >= ya ? rows / (yb - ya + 1) : 0;
}

/**
 * Group staves (sorted top to bottom) into SYSTEMS and set `system`, `partIndex` and `lowerOfGrand`.
 *
 * A system is a run of staves that are aligned at the left edge and joined by a continuous vertical line (system
 * barline) and / or a brace or bracket just left of the staves. Any number of staves can be joined: a vocal line with
 * a piano part (3 staves), a choir (4), a quartet ... The piano grand staff inside such a system is the LOWEST pair when
 * a brace spans only that pair (the gap above the pair has no brace). A system of exactly two joined staves is a grand
 * staff (the lower one defaults to the bass clef), as before.
 */
export function regroupSystems(b: Binary, staves: Staff[]): number[][] {
  const systems: number[][] = [];
  let cur: number[] = [];
  const joined: boolean[] = [false];
  for (let i = 0; i < staves.length; i++) {
    const s = staves[i];
    let join = false;
    if (i > 0) {
      const p = staves[i - 1];
      const d = Math.min(s.staffSpace, p.staffSpace);
      const gap = s.top - p.bottom;
      const aligned = Math.abs(s.left - p.left) < 2 * d && Math.abs(s.right - p.right) < 6 * d;
      if (aligned && gap < 30 * d) {
        // a continuous system barline joins staves even across lyrics (large gap); a brace alone needs a small gap
        const cov = columnInk(b, p.left - 3 * d, p.left + 0.3 * d, p.bottom + 0.3 * d, s.top - 0.3 * d);
        join = cov >= 0.9 || (cov >= 0.7 && gap < 14 * d);
      }
    }
    joined[i] = join;
    if (!join && cur.length) {
      systems.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) systems.push(cur);
  for (const sys of systems) {
    sys.forEach((k, pi) => {
      staves[k].system = systems.indexOf(sys);
      staves[k].partIndex = pi;
      staves[k].lowerOfGrand = false;
    });
    if (sys.length === 2) staves[sys[1]].lowerOfGrand = true;
    else if (sys.length >= 3) {
      // brace (not just the system barline) in the gap rows left of the staves
      const braced = (g: number) => {
        const p = staves[sys[g]];
        const s = staves[sys[g + 1]];
        const d = Math.min(s.staffSpace, p.staffSpace);
        return rowInk(b, p.left - 2.5 * d, p.left - 0.35 * d, p.bottom + 0.3 * d, s.top - 0.3 * d) >= 0.25;
      };
      const last = sys.length - 2;
      if (braced(last) && !braced(last - 1)) staves[sys[sys.length - 1]].lowerOfGrand = true;
    }
  }
  return systems;
}

/**
 * True when a small "8" sits below the treble clef of this staff (tenor clef, or guitar clef printed with the 8).
 * The clef's own tail ends about 1.7 staff spaces below the bottom line; the 8 occupies roughly 1.8 .. 2.8 spaces below
 * it, so any ink in the window under the tail (x over the clef's width) is the 8.
 */
export function hasClefEight(b: Binary, staff: Staff): boolean {
  const d = staff.staffSpace;
  const by = lineY(staff, 4, staff.left + 2 * d);
  const yTop = Math.round(by + 2.0 * d);
  let n = 0;
  for (let x = Math.round(staff.left + 1.2 * d); x <= staff.left + 3.5 * d; x++) {
    if (x < 0 || x >= b.width) continue;
    // a column whose ink runs on upward for 3+ staff spaces is the clef's own spine / a stem, not the 8
    let up = 0;
    for (let y = yTop; y >= 0 && b.data[y * b.width + x] && up < 3 * d; y--) up++;
    if (up >= 3 * d) continue;
    for (let y = yTop; y <= by + 3.6 * d; y++) if (y >= 0 && y < b.height && b.data[y * b.width + x]) n++;
  }
  return n / (d * d) >= 0.2;
}

/** Y limit for chord text above staff `i`: bottom of the staff above it (if any, overlapping in x) + 0.6 staff spaces. */
function chordLimitTop(staves: Staff[], i: number): number {
  const staff = staves[i];
  let limitTop = -Infinity;
  for (let j = 0; j < staves.length; j++) {
    if (j === i) continue;
    const o = staves[j];
    if (o.right < staff.left || o.left > staff.right) continue;
    if (o.bottom <= staff.top) limitTop = Math.max(limitTop, o.bottom + 0.6 * o.staffSpace);
  }
  return limitTop;
}

/**
 * Read chord symbols (OCR) above the first staff of every system of an analyzed page and store them in
 * `page.chordLabels` (index = system). Never throws: on any failure the page simply has no chord labels.
 * Requires `page.binary` (set by `analyzePage`).
 */
export async function readPageChords(page: PageResult, opts: { onProgress?: RecognizeOptions['onProgress'] } = {}): Promise<ChordLabel[][]> {
  const out: ChordLabel[][] = page.systems.map(() => []);
  page.chordLabels = out;
  if (!page.binary) return out;
  for (let s = 0; s < page.systems.length; s++) {
    const first = page.systems[s][0];
    if (first === undefined) continue;
    if (chordOcrUnavailable()) break; // OCR failed or timed out earlier in this run: skip the rest
    try {
      out[s] = await detectChordLabels(page.binary, page.staves[first], {
        limitTop: chordLimitTop(page.staves, first),
        grey: page.grey ? { data: page.grey, width: page.binary.width, height: page.binary.height } : undefined,
      });
    } catch {
      out[s] = [];
    }
    opts.onProgress?.({ stage: 'Reading chord symbols', fraction: (s + 1) / page.systems.length, page: page.index });
  }
  return out;
}

/**
 * A triplet bracket found near one staff belongs to the staff whose notes it spans: the one with the smallest gap
 * between the bracket and the heads / stems under (or over) it. Brackets seen by two neighbouring staves are merged.
 */
function assignTuplets(staves: Staff[], symbols: StaffSymbols[]): void {
  const cands: { x0: number; x1: number; n: number; y0: number; y1: number }[] = [];
  for (const s of symbols) {
    for (const c of s.tupletCands ?? []) {
      if (!cands.some((o) => Math.abs(o.x0 - c.x0) < 3 && Math.abs(o.x1 - c.x1) < 3 && Math.abs(o.y0 - c.y0) < 3)) cands.push(c);
    }
  }
  for (const c of cands) {
    let best = -1;
    let bestGap = Infinity;
    symbols.forEach((s, j) => {
      const d = staves[j].staffSpace;
      let ymin = Infinity;
      let ymax = -Infinity;
      let count = 0;
      for (const h of s.heads) {
        if (h.cx < c.x0 - 0.3 * d || h.cx > c.x1 + 0.3 * d) continue;
        count++;
        ymin = Math.min(ymin, h.y0);
        ymax = Math.max(ymax, h.y1);
        if (h.stemId >= 0) {
          const st = s.stems[h.stemId];
          ymin = Math.min(ymin, st.top);
          ymax = Math.max(ymax, st.bottom);
        }
      }
      for (const r of s.rests) {
        const cx = (r.x0 + r.x1) / 2;
        if (cx < c.x0 - 0.3 * d || cx > c.x1 + 0.3 * d) continue;
        count++;
        ymin = Math.min(ymin, r.y0);
        ymax = Math.max(ymax, r.y1);
      }
      if (count === 0) return;
      const gap = c.y1 <= ymin ? ymin - c.y1 : c.y0 >= ymax ? c.y0 - ymax : 0;
      // the bracket hugs its notes: within about four staff spaces of the nearest head / stem
      if (gap <= 4.2 * d && gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    });
    if (best >= 0) (symbols[best].tuplets ??= []).push({ x0: c.x0, x1: c.x1, n: c.n });
  }
}

function boxOf(page: PageResult, x0: number, y0: number, x1: number, y1: number): OmrBox {
  const pts = [
    toOriginal(page.transform, x0, y0),
    toOriginal(page.transform, x1, y0),
    toOriginal(page.transform, x0, y1),
    toOriginal(page.transform, x1, y1),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { page: page.index, x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** Most common value of a list (first wins ties). */
function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bc = -1;
  for (const v of values) {
    const c = counts.get(v)!;
    if (c > bc) {
      bc = c;
      best = v;
    }
  }
  return best;
}

/**
 * Make every staff of one system share the same barlines. Barlines run through all staves of a system, so a barline is
 * kept when at least half of the staves report one at (about) the same x: a barline one staff missed is restored,
 * a spurious one found in a single staff of three or more is dropped (two staves: union, as either could be right).
 * Each staff keeps its own x where it has a barline in the cluster, otherwise the cluster mean is used.
 * Returns shallow copies of the symbols (barlines, signature-change indices and multi-rest counts adjusted); a
 * single-staff system is returned unchanged.
 */
export function alignBarlines(syms: StaffSymbols[], spaces: number[]): StaffSymbols[] {
  if (syms.length < 2) return syms;
  const d = Math.min(...spaces);
  const tol = 1.5 * d;
  const all: { x: number; s: number }[] = [];
  syms.forEach((sym, s) => sym.barlines.forEach((x) => all.push({ x, s })));
  if (all.length === 0) return syms;
  all.sort((a, b) => a.x - b.x);
  const clusters: { x: number; s: number }[][] = [];
  for (const e of all) {
    const last = clusters[clusters.length - 1];
    if (last && e.x - last[last.length - 1].x <= tol) last.push(e);
    else clusters.push([e]);
  }
  const keep = clusters.filter((c) => new Set(c.map((e) => e.s)).size * 2 >= syms.length);
  if (keep.length === 0) return syms;
  return syms.map((sym, s) => {
    const bars = keep.map((c) => {
      const own = c.filter((e) => e.s === s);
      return own.length > 0 ? own[0].x : c.reduce((t, e) => t + e.x, 0) / c.length;
    });
    // old barline index -> new index (nearest kept cluster)
    const remap = sym.barlines.map((x) => {
      let best = 0;
      for (let k = 1; k < bars.length; k++) if (Math.abs(bars[k] - x) < Math.abs(bars[best] - x)) best = k;
      return best;
    });
    const same = bars.length === sym.barlines.length && bars.every((x, i) => x === sym.barlines[i]);
    if (same) return sym;
    const out: StaffSymbols = { ...sym, barlines: bars };
    if (sym.signatureChanges) out.signatureChanges = sym.signatureChanges.map((c) => ({ ...c, barline: remap[c.barline] ?? c.barline }));
    if (sym.multiRests) {
      // a multi-measure rest that other staves split with barlines stands for one measure here (the others are empty bars)
      out.multiRests = sym.multiRests.map((m) => (bars.some((x) => x > m.x0 && x < m.x1) ? { ...m, count: 1 } : m));
    }
    return out;
  });
}

/** Build a Score from analyzed pages. */
export function assembleScore(pages: PageResult[], ppq = 480, opts: { instrument?: OmrInstrument } = {}): Score {
  const score = createEmptyScore({ source: 'omr' });
  score.ppq = ppq;
  const warnings: string[] = [];
  const boxes: Record<string, OmrBox[]> = {};
  for (const p of pages) warnings.push(...p.warnings);

  // Pass 1: per-system measure event lists
  interface SysInfo {
    page: PageResult;
    staffIds: number[];
    measures: Map<number, RhythmEvent[][]>;
    /** per staff: measure cells that hold chord-slash notation */
    slash: Map<number, boolean[]>;
    /** signature changes after double barlines (mid-system: measure < count; trailing: measure >= count) */
    changes: SigChange[];
    count: number;
    /** chord labels placed by measure offset within the system; `frac` = position within the measure (0..1) */
    chords: Map<number, { label: ChordLabel; frac: number }[]>;
  }
  const sysInfos: SysInfo[] = [];
  for (const page of pages) {
    page.systems.forEach((sys, sysNo) => {
      const measures = new Map<number, RhythmEvent[][]>();
      const slash = new Map<number, boolean[]>();
      let changes: SigChange[] = [];
      let count = 0;
      const symsOf = alignBarlines(sys.map((si) => page.symbols[si]), sys.map((si) => page.staves[si].staffSpace));
      for (let sp = 0; sp < sys.length; sp++) {
        const si = sys[sp];
        const staff = page.staves[si];
        const lay = staffLayout(symsOf[sp], page.symbols[si].stems, staff.staffSpace, ppq);
        measures.set(si, lay.measures);
        slash.set(si, lay.slash);
        if (changes.length === 0) changes = lay.changes;
        count = Math.max(count, lay.measures.length);
      }
      const chords = sys.length > 0 ? placeChords(page.chordLabels?.[sysNo] ?? [], symsOf[0], page.staves[sys[0]].staffSpace, count) : new Map();
      if (count > 0 || sys.length > 0) sysInfos.push({ page, staffIds: sys, measures, slash, changes, count, chords });
    });
  }
  const totalMeasures = sysInfos.reduce((s, x) => s + x.count, 0);

  // Key signatures: vote per system, then only accept a change when two consecutive systems agree on it
  const sysKey = sysInfos.map((si) => modeOf(si.staffIds.map((i) => si.page.symbols[i].keyFifths)));
  // a courtesy key signature at the end of a system is what the NEXT system starts in
  const forcedKey: (number | undefined)[] = sysInfos.map(() => undefined);
  sysInfos.forEach((si, i) => {
    const t = si.changes.find((c) => c.measure >= si.count && c.keyFifths !== undefined);
    if (t && i + 1 < sysKey.length) forcedKey[i + 1] = t.keyFifths;
  });
  const effKey: number[] = [];
  {
    let cur = sysKey[0] ?? 0;
    if (sysKey.length >= 3 && sysKey[0] !== sysKey[1] && sysKey[1] === sysKey[2]) cur = sysKey[1];
    sysKey.forEach((f, i) => {
      const forced = forcedKey[i];
      if (forced !== undefined) cur = forced;
      else if (i > 0 && f !== cur && sysKey[i + 1] === f) cur = f;
      effKey.push(cur);
    });
  }

  const tracks = new Map<string, Track>();
  const trackFor = (key: string, name: string): Track => {
    let t = tracks.get(key);
    if (!t) {
      t = { id: `omr-${key}`, name, program: 25, notes: [] };
      tracks.set(key, t);
    }
    return t;
  };

  let cursor = 0;
  let measureNo = 0;
  let curTs = { numerator: 4, denominator: 4 };
  let tsKnown = false;
  const carryByStaffKey = new Map<string, Map<number, number>>();
  const lastClef = new Map<number, 'treble' | 'bass'>();
  let lastKey = Number.NaN;
  let mismatchCount = 0;
  let clippedCount = 0;
  let slashMeasures = 0;
  const slashList: { index: number; tick: number; length: number }[] = [];
  const chordList: OmrChordEntry[] = [];
  let pendingTie = new Map<string, { midi: number; step: number }>();
  let pendingSig: SigChange | undefined;
  let unmatchedTies = 0;
  let meterOverridden = false; // the current meter replaced a printed signature: note confidence is capped at 0.7
  // octave of treble clefs per part: a printed "8" below the clef (voted over all systems of the part), or every treble
  // clef when the music is for guitar. Score pitch is always the SOUNDING pitch.
  const eightVotes = new Map<number, { eight: number; total: number }>();
  for (const si of sysInfos) {
    for (const stIdx of si.staffIds) {
      if (si.page.symbols[stIdx].clef !== 'treble') continue;
      const part = si.page.staves[stIdx].partIndex;
      const v = eightVotes.get(part) ?? { eight: 0, total: 0 };
      v.total++;
      if (si.page.clefOctaves?.[stIdx] === -1) v.eight++;
      eightVotes.set(part, v);
    }
  }
  // The guitar shift applies only where the staff is not part of keyboard-style music: never inside a piano grand staff
  // or any system that contains a bass-clef staff (`guitarOk` false there).
  const octaveShift = (part: number, clef: 'treble' | 'bass', guitarOk: boolean): number => {
    if (clef !== 'treble') return 0;
    if (opts.instrument === 'guitar' && guitarOk) return -12;
    const v = eightVotes.get(part);
    return v && v.eight > 0 && v.eight * 2 >= v.total ? -12 : 0;
  };
  const explicitTsSys = sysInfos.map((x) => x.staffIds.some((i) => x.page.symbols[i].timeSig));
  const pageWarned = { clef: new Set<number>(), ts: new Set<number>() };

  for (let sIdx = 0; sIdx < sysInfos.length; sIdx++) {
    const si = sysInfos[sIdx];
    const syms = si.staffIds.map((i) => si.page.symbols[i]);
    // time signature: first staff of the system that reports one, else a courtesy signature carried from the end of
    // the previous system; later systems inherit silently
    const ts = syms.find((s) => s.timeSig)?.timeSig ?? pendingSig?.timeSig;
    const setTs = (t: { numerator: number; denominator: number }) => {
      if (!tsKnown || t.numerator !== curTs.numerator || t.denominator !== curTs.denominator) {
        const entry = { tick: cursor, numerator: t.numerator, denominator: t.denominator };
        if (cursor === 0) score.timeSignatures = [entry];
        else score.timeSignatures.push(entry);
        curTs = { numerator: t.numerator, denominator: t.denominator };
      }
      tsKnown = true;
    };
    if (ts) setTs(ts);
    else if (!tsKnown && syms.some((s) => s.timeSigUnreadable) && !pageWarned.ts.has(si.page.index)) {
      pageWarned.ts.add(si.page.index);
      warnings.push(`Page ${si.page.index + 1}: a time signature could not be read; assumed 4/4.`);
    }
    // Meter inference runs for every system. With no printed signature it fills the gap (a looser 2-bar rule applies);
    // a signature read from digits (not a common / cut-time C, which are reliable) is overridden when the bars
    // consistently add up to a different meter.
    {
      const printedDigits = !!ts && !(ts.numerator === 4 && ts.denominator === 4) && !(ts.numerator === 2 && ts.denominator === 2);
      const inferred = inferMeter(sysInfos, sIdx, explicitTsSys, ppq, curTs, measureNo === 0, !ts);
      if (inferred && !ts) {
        setTs(inferred.ts);
        warnings.push(
          inferred.lowConfidence
            ? `Page ${si.page.index + 1}: ${inferred.bars} measures add up to ${inferred.ts.numerator}/${inferred.ts.denominator}; time signature guessed as ${inferred.ts.numerator}/${inferred.ts.denominator} (low confidence).`
            : `Page ${si.page.index + 1}: ${inferred.bars} consecutive measures add up to ${inferred.ts.numerator}/${inferred.ts.denominator} rather than the assumed meter; time signature inferred as ${inferred.ts.numerator}/${inferred.ts.denominator}.`,
        );
      } else if (inferred && ts && printedDigits && !inferred.lowConfidence && inferred.bars >= 4 && inferred.bars >= 0.75 * inferred.total) {
        // overriding a PRINTED signature needs >= 4 agreeing bars and >= 75% agreement
        warnings.push(
          `Page ${si.page.index + 1}: Printed time signature ${ts.numerator}/${ts.denominator} disagrees with bar lengths; using ${inferred.ts.numerator}/${inferred.ts.denominator}`,
        );
        setTs(inferred.ts);
        meterOverridden = true;
      } else if (ts) meterOverridden = false;
    }
    pendingSig = undefined;
    const fifths = effKey[sIdx] ?? 0;
    if (fifths !== lastKey) {
      if (cursor === 0) score.keySignatures = [{ tick: 0, fifths, mode: 'major' }];
      else score.keySignatures.push({ tick: cursor, fifths, mode: 'major' });
      lastKey = fifths;
    }
    let nominal = (ppq * 4 * curTs.numerator) / curTs.denominator;
    let fifthsNow = fifths;
    // track layout: the two staves of a piano grand staff share ONE track (voice 0 = upper, voice 1 = lower); every other
    // staff of the system gets its own track (voice 0), so all tracks share one measure timeline
    const placeOf = (sPos: number): { key: string; name: string; voice: number } => {
      const st = si.page.staves[si.staffIds[sPos]];
      // a braced pair whose lower staff has a printed TREBLE clef is voice + guitar (or similar), not a piano grand staff
      const isLowerOfGrand = (k: number) => {
        const sy = si.page.symbols[si.staffIds[k]];
        return k > 0 && si.page.staves[si.staffIds[k]].lowerOfGrand && !(sy.clefDetected && sy.clef === 'treble');
      };
      const lower = isLowerOfGrand(sPos);
      const upperOfGrand = sPos + 1 < si.staffIds.length && isLowerOfGrand(sPos + 1);
      if (lower || upperOfGrand) {
        const part = lower ? si.page.staves[si.staffIds[sPos - 1]].partIndex : st.partIndex;
        return { key: part === 0 ? 'grand' : `grand${part}`, name: 'Piano', voice: lower ? 1 : 0 };
      }
      return { key: `part${st.partIndex}`, name: si.staffIds.length > 1 ? `Staff ${st.partIndex + 1}` : 'Melody', voice: 0 };
    };
    // clef per staff row: inherit the previous system's clef when none is printed
    const clefs = si.staffIds.map((stIdx) => {
      const sym = si.page.symbols[stIdx];
      const part = si.page.staves[stIdx].partIndex;
      if (sym.clefDetected) {
        lastClef.set(part, sym.clef);
        return sym.clef;
      }
      const prev = lastClef.get(part);
      if (prev && !si.page.staves[stIdx].lowerOfGrand) return prev;
      if (sym.clefMissing && !pageWarned.clef.has(si.page.index)) {
        pageWarned.clef.add(si.page.index);
        warnings.push(`Page ${si.page.index + 1}: no clef was found on at least one staff; assumed ${sym.clef}.`);
      }
      return sym.clef;
    });
    for (const sym of syms) {
      const mrs = sym.multiRests ?? [];
      mrs.forEach((mr) => {
        if (!mr.guessed) return;
        // bar number: first bar of this system + barlines before the rest + extra bars of earlier multi-measure rests
        const centre = (mr.x0 + mr.x1) / 2;
        const slot = sym.barlines.filter((b) => b < centre).length;
        let extra = 0;
        for (const o of mrs) if (o !== mr && (o.x0 + o.x1) / 2 < centre) extra += Math.max(0, o.count - 1);
        warnings.push(`Page ${si.page.index + 1}: the multi-measure rest at measure ${measureNo + slot + extra + 1} has no readable count; counted as 1 measure.`);
      });
    }
    const nextPending = new Map<string, { midi: number; step: number }>();
    const firstDone = new Set<string>();

    for (let m = 0; m < Math.max(1, si.count); m++) {
      // signature changes after a mid-staff double barline apply from this measure
      if (m > 0) {
        for (const c of si.changes) {
          if (c.measure !== m) continue;
          if (c.timeSig) {
            setTs(c.timeSig);
            nominal = (ppq * 4 * curTs.numerator) / curTs.denominator;
          }
          if (c.keyFifths !== undefined && c.keyFifths !== fifthsNow) {
            fifthsNow = c.keyFifths;
            score.keySignatures.push({ tick: cursor, fifths: fifthsNow, mode: 'major' });
            lastKey = fifthsNow;
          }
        }
      }
      const start = cursor;
      let slashHere = false;
      si.staffIds.forEach((stIdx, sPos) => {
        const staff: Staff = si.page.staves[stIdx];
        const sym = si.page.symbols[stIdx];
        const events = si.measures.get(stIdx)?.[m] ?? [];
        if (si.slash.get(stIdx)?.[m] && events.length === 0) slashHere = true;
        if (events.length === 0) return;
        const isFirst = measureNo === 0;
        const isLast = measureNo === totalMeasures - 1;
        const layout = layoutMeasure(events, nominal, ppq, isFirst || isLast);
        if (layout.mismatch) mismatchCount++;
        if (layout.clipped) clippedCount++;
        const place = placeOf(sPos);
        const key = place.key;
        const track = trackFor(key, place.name);
        const voice = place.voice;
        const shift = octaveShift(staff.partIndex, clefs[sPos], !place.key.startsWith('grand') && !clefs.includes('bass'));
        const ckey = `${key}:${voice}`;
        const heads = layout.placed.flatMap((p) => (p.event.kind === 'cluster' ? p.event.cluster.heads : []));
        const { pitched, carry } = pitchMeasure(heads, staff, clefs[sPos], fifthsNow, carryByStaffKey.get(ckey) ?? new Map());
        carryByStaffKey.set(ckey, carry);
        const byHead = new Map(pitched.map((p) => [p.head, p]));
        for (const pe of layout.placed) {
          if (pe.event.kind !== 'cluster') continue;
          const c = pe.event.cluster;
          const isFirstCluster = !firstDone.has(ckey);
          c.heads.forEach((h, hi) => {
            const p = byHead.get(h);
            if (!p) return;
            const id = newNoteId();
            let dur = layout.snapped && pe.event.tuplet !== 3 ? snapStandardTicks(c.durations[hi] * pe.scale, ppq) : quantizeTicks(c.durations[hi] * pe.scale, pe.grid);
            dur = Math.max(pe.grid, Math.min(dur, Math.max(pe.grid, nominal - pe.start)));
            const lowered = layout.clipped ? 0.6 : layout.snapped ? 0.7 : layout.scaled ? 0.75 : layout.repaired ? 0.7 : layout.underfull ? 0.8 : layout.tuplet && layout.mismatch ? 0.8 : layout.mismatch ? 0.85 : 1;
            const midi = Math.max(0, Math.min(127, p.midi + shift));
            const spelling = shift === 0 ? p.spelling : { ...p.spelling, octave: p.spelling.octave + shift / 12 };
            const note: Note = {
              id,
              pitch: midi,
              start: start + pe.start,
              duration: dur,
              velocity: 90,
              voice,
              spelling,
              confidence: Math.max(0.05, Math.min(meterOverridden ? 0.7 : 1, h.confidence * lowered)),
            };
            if (h.tiedFromPrevious) note.tiedFromPrevious = true;
            const pt = pendingTie.get(ckey);
            if (isFirstCluster && pt && (pt.midi === midi || pt.step === h.step)) {
              note.tiedFromPrevious = true;
              pendingTie.delete(ckey);
            }
            if (sym.tieOut === h || sym.tieOuts?.includes(h)) nextPending.set(ckey, { midi, step: h.step });
            track.notes.push(note);
            boxes[id] = [boxOf(si.page, h.x0, h.y0, h.x1, h.y1)];
          });
          firstDone.add(ckey);
        }
      });
      if (slashHere) {
        slashMeasures++;
        slashList.push({ index: measureNo, tick: start, length: nominal });
      }
      for (const { label, frac } of si.chords.get(m) ?? []) {
        // snap to the nearest beat of the measure (beats of the time signature's denominator unit)
        const beat = (ppq * 4) / curTs.denominator;
        const nBeats = Math.max(1, Math.round(nominal / beat));
        const tick = start + Math.min(nBeats - 1, Math.max(0, Math.round(frac * nBeats))) * beat;
        const prev = chordList[chordList.length - 1];
        if (prev && prev.tick === tick) {
          if (label.confidence > prev.confidence) chordList[chordList.length - 1] = toEntry(label, measureNo, tick);
        } else chordList.push(toEntry(label, measureNo, tick));
      }
      cursor += nominal;
      measureNo++;
    }
    // a tie that ran off the end of this system whose partner never appeared at the start of the next one
    unmatchedTies += pendingTie.size;
    pendingTie = nextPending;
    // courtesy key / time signature after the last barline: applies from the first measure of the next system
    const trailing = si.changes.filter((c) => c.measure >= si.count);
    if (trailing.length > 0) {
      pendingSig = { measure: si.count, timeSig: trailing.find((c) => c.timeSig)?.timeSig, keyFifths: trailing.find((c) => c.keyFifths !== undefined)?.keyFifths };
    }
  }

  const trackList = [...tracks.values()];
  for (const t of trackList) t.notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  if (trackList.length > 0) trackList[0].isGuitarTarget = true;
  score.tracks = trackList;
  if (mismatchCount > 0) {
    warnings.push(`${mismatchCount} measure(s) did not add up to the time signature; durations were adjusted. Check rhythms.`);
  }
  if (clippedCount > 0) warnings.push(`${clippedCount} measure(s) could not be fitted to the time signature and were clipped at the barline.`);
  if (slashMeasures > 0) warnings.push(`${slashMeasures} chord-slash measure(s) were found; they have no notes and are listed in meta.omrSlashMeasures.`);
  if (unmatchedTies > 0) warnings.push(`${unmatchedTies} tie(s) running off the end of a line had no matching note at the start of the next line.`);
  if (trackList.every((t) => t.notes.length === 0)) warnings.push('No notes were recognized. Try a cleaner, higher-resolution scan.');
  score.meta.warnings = [...new Set(warnings)];
  score.meta.omrBoxes = boxes;
  score.meta.omrMeasures = measureNo;
  if (slashList.length > 0) score.meta.omrSlashMeasures = slashList;
  if (chordList.length > 0) score.meta.omrChords = chordList;
  return score;
}

export interface OmrChordEntry {
  /** 0-based measure index as counted by the assembler */
  measure: number;
  /** absolute tick of the chord (snapped to the nearest beat of its measure) */
  tick: number;
  text: string;
  chord: { root: string; quality: string; bass?: string };
  confidence: number;
}

function toEntry(l: ChordLabel, measure: number, tick: number): OmrChordEntry {
  return { measure, tick, text: l.text, chord: l.chord, confidence: l.confidence };
}

/**
 * Map chord labels of one system to measure offsets (within the system) and a fractional position inside the measure.
 * Offsets follow `staffLayout`: one per barline cell, except that a multi-measure rest cell expands to `count` measures.
 * A label over a multi-measure rest lands on its first measure; further labels over the same rest are spread by x.
 */
function placeChords(labels: ChordLabel[], sym: StaffSymbols, d: number, count: number): Map<number, { label: ChordLabel; frac: number }[]> {
  const out = new Map<number, { label: ChordLabel; frac: number }[]>();
  if (labels.length === 0) return out;
  const bars = sym.barlines;
  const slotOf = (x: number) => {
    let k = 0;
    for (let i = 0; i < bars.length; i++) if (x >= bars[i]) k = i + 1;
    return k;
  };
  const multi = new Map<number, number>();
  for (const m of sym.multiRests ?? []) multi.set(slotOf((m.x0 + m.x1) / 2), m.count);
  const offsetOfSlot = (k: number) => {
    let off = k;
    for (const [slot, cnt] of multi) if (slot < k && cnt > 1) off += cnt - 1;
    return off;
  };
  const firstInSlot = new Set<number>();
  for (const label of [...labels].sort((a, b) => a.x - b.x)) {
    // the label's x is the word centre; chord symbols start at their left edge
    // (the measure is decided by the centre; the position inside it by the estimated left edge)
    const k = slotOf(label.x);
    const x0 = k === 0 ? sym.musicStart : bars[k - 1];
    const x1 = k < bars.length ? bars[k] : (sym.staffRight ?? x0 + 1);
    const left = label.x - 0.25 * d * label.text.length;
    const frac = Math.max(0, Math.min(0.999, (left - x0) / Math.max(1, x1 - x0)));
    const cnt = multi.get(k) ?? 1;
    let off = offsetOfSlot(k);
    let f = frac;
    if (cnt > 1) {
      if (!firstInSlot.has(k)) {
        firstInSlot.add(k);
        f = 0;
      } else {
        const pos = Math.min(cnt - 1, Math.floor(frac * cnt));
        off += pos;
        f = Math.max(0, frac * cnt - pos);
      }
    }
    if (off >= count) continue;
    const arr = out.get(off) ?? [];
    arr.push({ label, frac: f });
    out.set(off, arr);
  }
  return out;
}

/**
 * Infer the meter of a system with no printed time signature from how its bars add up. Needs at least 3 bars with
 * notes (pooled from following unsigned systems when this one has fewer) and >= 60% of them agreeing on one total that
 * differs from the current meter. Returns undefined when the evidence is thin or already matches `cur`.
 */
function inferMeter(
  sysInfos: { staffIds: number[]; measures: Map<number, RhythmEvent[][]>; count: number }[],
  from: number,
  explicit: boolean[],
  ppq: number,
  cur: { numerator: number; denominator: number },
  firstSystem: boolean,
  allowShort = false,
): { ts: { numerator: number; denominator: number }; bars: number; total: number; lowConfidence?: boolean } | undefined {
  const nominalCur = (ppq * 4 * cur.numerator) / cur.denominator;
  const totals: number[] = [];
  for (let k = from; k < sysInfos.length && k <= from + 3 && totals.length < 3; k++) {
    if (k > from && explicit[k]) break;
    const si = sysInfos[k];
    const last = k === sysInfos.length - 1;
    for (const st of si.staffIds) {
      const ms = si.measures.get(st) ?? [];
      ms.forEach((ev, m) => {
        if (!ev.some((e) => e.kind === 'cluster')) return;
        if ((firstSystem && k === from && m === 0) || (last && m === ms.length - 1)) return; // pickup / final bar may be short
        totals.push(rawMeasureTotal(ev, ppq, nominalCur));
      });
    }
  }
  const simple: Record<string, [number, number]> = { '2': [2, 4], '3': [3, 4], '4': [4, 4], '1.5': [3, 8], '4.5': [9, 8], '6': [12, 8] };
  const lowTs = (t: number, bars: number) => {
    const m = simple[String(t / ppq)];
    return m ? { ts: { numerator: m[0], denominator: m[1] }, bars, total: totals.length, lowConfidence: true } : undefined;
  };
  if (totals.length < 3) {
    // short piece: >= 2 full bars that ALL agree on a valid simple meter are accepted with low confidence
    if (!allowShort || totals.length < 2 || totals.some((t) => t !== totals[0]) || totals[0] === nominalCur) return undefined;
    return lowTs(totals[0], totals.length);
  }
  const counts = new Map<number, number>();
  for (const t of totals) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = 0;
  let bc = 0;
  for (const [t, c] of counts) if (c > bc) { best = t; bc = c; }
  if (best === nominalCur) return undefined;
  if (bc < 3 || bc < 0.6 * totals.length) {
    // no printed signature: accept a clear plurality (>= 60% of <= 4 bars, or >= 4 bars and twice any rival) with low confidence
    const rival = Math.max(0, ...[...counts].filter(([t]) => t !== best).map(([, c]) => c));
    const clear = (totals.length <= 4 && bc >= 2 && bc >= 0.6 * totals.length) || (bc >= 4 && bc >= 2 * rival && bc >= 0.4 * totals.length);
    return allowShort && clear ? lowTs(best, bc) : undefined;
  }
  let ts: { numerator: number; denominator: number } | undefined;
  if (best % ppq === 0 && best / ppq >= 2 && best / ppq <= 7) ts = { numerator: best / ppq, denominator: 4 };
  else if (best % (ppq / 2) === 0) {
    const n8 = best / (ppq / 2);
    if (n8 >= 5 && n8 <= 13) ts = { numerator: n8, denominator: 8 };
  }
  return ts ? { ts, bars: bc, total: totals.length } : undefined;
}

/**
 * Pure end-to-end recognition over raw RGBA pages (no DOM, usable in a Worker or under node/jsdom tests).
 * Page images are NOT stored in `meta.sourcePages` here; `recognizeScore` in index.ts adds those from the canvases.
 */
export function recognizeImageData(pages: RawImage[], opts: RecognizeOptions = {}): Score {
  const results: PageResult[] = [];
  pages.forEach((img, i) => {
    opts.onProgress?.({ stage: 'Analyzing page', fraction: i / Math.max(1, pages.length), page: i });
    results.push(analyzePage(img, i, opts));
  });
  opts.onProgress?.({ stage: 'Assembling score', fraction: 0.97 });
  const score = assembleScore(results, 480, { instrument: opts.instrument });
  opts.onProgress?.({ stage: 'Done', fraction: 1 });
  return score;
}


/**
 * Like `recognizeImageData` but also reads chord symbols (OCR, lazy-loaded tesseract.js) and attaches
 * `meta.omrChords`. Chord reading never fails the recognition: on any error the score simply has no chords.
 */
export async function recognizeImageDataWithChords(pages: RawImage[], opts: RecognizeOptions = {}): Promise<Score> {
  resetChordOcrState();
  const results: PageResult[] = [];
  pages.forEach((img, i) => {
    opts.onProgress?.({ stage: 'Analyzing page', fraction: (0.8 * i) / Math.max(1, pages.length), page: i });
    results.push(analyzePage(img, i, opts));
  });
  try {
    for (let i = 0; i < results.length; i++) {
      try {
        await readPageChords(results[i], {
          onProgress: (p) => opts.onProgress?.({ stage: p.stage, fraction: 0.8 + (0.17 * (i + p.fraction)) / results.length, page: i }),
        });
      } catch {
        /* chords are optional */
      }
    }
  } finally {
    await disposeChordOcr();
  }
  opts.onProgress?.({ stage: 'Assembling score', fraction: 0.97 });
  const score = assembleScore(results, 480, { instrument: opts.instrument });
  if (chordOcrUnavailable()) score.meta.warnings = [...(score.meta.warnings ?? []), 'Chord symbols could not be read (OCR unavailable).'];
  for (const r of results) { delete r.binary; delete r.grey; }
  opts.onProgress?.({ stage: 'Done', fraction: 1 });
  return score;
}
