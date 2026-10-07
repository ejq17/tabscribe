import { measuresOf, type GuitarConfig, type Measure, type Note, type Score } from '../core';
import type { ChordEvent } from '../chords';
import { guitarNotes } from '../store/ops';

export const LABEL_W = 26;
export const SIDE_PAD = 10;
export const LINE_GAP = 16;
export const MIN_MEASURE_W = 96;
export const COL_W = 34;
export const LEAD = 20;
export const TRAIL = 12;
export const TS_W = 20;
export const CHORD_ROW_H = 22;
export const DIAGRAM_ROW_H = 92;
export const STEM_AREA_H = 44;
export const SYSTEM_GAP = 22;

export interface MeasureLayout {
  measure: Measure;
  x: number;
  w: number;
  showTs: boolean;
  /** (tick, x) anchor points, ascending in both */
  pts: { tick: number; x: number }[];
  notes: Note[];
}

export interface SystemLayout {
  index: number;
  y: number;
  /** y of the top string line */
  staffTop: number;
  chordY: number;
  diagramY: number;
  height: number;
  measures: MeasureLayout[];
  startTick: number;
  endTick: number;
}

export interface TabLayout {
  systems: SystemLayout[];
  width: number;
  height: number;
  nStrings: number;
  ppq: number;
}

export interface LayoutOptions {
  width: number;
  showChords: boolean;
  showDiagrams: boolean;
}

export function tickToX(m: MeasureLayout, tick: number): number {
  const pts = m.pts;
  if (tick <= pts[0].tick) return pts[0].x;
  for (let i = 1; i < pts.length; i++) {
    if (tick <= pts[i].tick) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.tick === a.tick ? b.x : a.x + ((tick - a.tick) / (b.tick - a.tick)) * (b.x - a.x);
    }
  }
  return pts[pts.length - 1].x;
}

export function xToTick(m: MeasureLayout, x: number): number {
  const pts = m.pts;
  if (x <= pts[0].x) return pts[0].tick;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.x === a.x ? a.tick : a.tick + ((x - a.x) / (b.x - a.x)) * (b.tick - a.tick);
    }
  }
  return pts[pts.length - 1].tick;
}

/** Tick for a click at layout-x within a measure, snapped to the 16th grid and clamped inside the measure. */
export function measureClickTick(m: MeasureLayout, x: number, ppq: number): number {
  const grid = ppq / 4;
  const t = Math.round(xToTick(m, x) / grid) * grid;
  return Math.max(m.measure.startTick, Math.min(m.measure.endTick - grid, t));
}

export function findSystem(layout: TabLayout, tick: number): { sys: SystemLayout; m: MeasureLayout } | null {
  for (const sys of layout.systems) {
    if (tick >= sys.startTick && tick < sys.endTick) {
      const m = sys.measures.find((mm) => tick >= mm.measure.startTick && tick < mm.measure.endTick);
      if (m) return { sys, m };
    }
  }
  const last = layout.systems[layout.systems.length - 1];
  if (last && tick >= last.endTick) return { sys: last, m: last.measures[last.measures.length - 1] };
  return null;
}

export function layoutTab(score: Score, guitar: GuitarConfig, chords: ChordEvent[], opts: LayoutOptions): TabLayout {
  void guitar;
  const nStrings = guitar.tuning.pitches.length;
  const measures = measuresOf(score);
  const notes = guitarNotes(score);
  const byMeasure: Note[][] = measures.map(() => []);
  // measures are contiguous, find index by scanning pointer
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let mi = 0;
  for (const n of sorted) {
    while (mi < measures.length - 1 && n.start >= measures[mi].endTick) mi++;
    byMeasure[mi].push(n);
  }

  const avail = Math.max(240, opts.width - SIDE_PAD * 2 - LABEL_W);
  interface Raw {
    measure: Measure;
    notes: Note[];
    onsets: number[];
    w0: number;
    showTs: boolean;
  }
  const raws: Raw[] = measures.map((measure, i) => {
    const onsets = [...new Set(byMeasure[i].map((n) => n.start))].sort((a, b) => a - b);
    const prev = measures[i - 1];
    const showTs =
      i === 0 || prev.timeSignature.numerator !== measure.timeSignature.numerator || prev.timeSignature.denominator !== measure.timeSignature.denominator;
    const w0 = Math.max(MIN_MEASURE_W, onsets.length * COL_W + LEAD + TRAIL) + (showTs ? TS_W : 0);
    return { measure, notes: byMeasure[i], onsets, w0, showTs };
  });

  // Greedy line breaking
  const lines: Raw[][] = [];
  let cur: Raw[] = [];
  let sum = 0;
  for (const r of raws) {
    if (cur.length > 0 && sum + r.w0 > avail) {
      lines.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(r);
    sum += r.w0;
  }
  if (cur.length) lines.push(cur);

  const chordsOn = opts.showChords;
  const diagOn = opts.showDiagrams;
  let y = 8;
  const systems: SystemLayout[] = lines.map((line, li) => {
    const total = line.reduce((a, r) => a + r.w0, 0);
    const isLast = li === lines.length - 1;
    const scale = isLast ? Math.min(1.25, avail / total) : avail / total;
    let x = SIDE_PAD + LABEL_W;
    const ms: MeasureLayout[] = line.map((r) => {
      const w = r.w0 * scale;
      const lead = LEAD + (r.showTs ? TS_W : 0);
      const innerL = x + lead;
      const innerR = x + w - TRAIL;
      const len = r.measure.endTick - r.measure.startTick;
      const gap = COL_W * 0.8;
      const pts: { tick: number; x: number }[] = [];
      let lastX = innerL - gap;
      for (const t of r.onsets) {
        const ideal = innerL + ((t - r.measure.startTick) / len) * (innerR - innerL);
        const px = Math.max(ideal, lastX + gap);
        pts.push({ tick: t, x: px });
        lastX = px;
      }
      // If crowding pushed past the right edge, widen this measure (shifts later ones below)
      const needRight = lastX + TRAIL;
      let wFinal = w;
      if (needRight > x + w) wFinal = needRight - x;
      if (pts.length === 0 || pts[0].tick > r.measure.startTick) pts.unshift({ tick: r.measure.startTick, x: innerL });
      pts.push({ tick: r.measure.endTick, x: Math.max(x + wFinal - TRAIL, lastX + gap * 0.5) });
      const layout: MeasureLayout = { measure: r.measure, x, w: wFinal, showTs: r.showTs, pts, notes: r.notes };
      x += wFinal;
      return layout;
    });
    const chordY = y;
    if (chordsOn) y += CHORD_ROW_H;
    const diagramY = y;
    if (diagOn) y += DIAGRAM_ROW_H;
    const staffTop = y + 12;
    const height = staffTop + (nStrings - 1) * LINE_GAP + STEM_AREA_H + 6 - chordY;
    const sys: SystemLayout = {
      index: li,
      y: chordY,
      chordY,
      diagramY,
      staffTop,
      height,
      measures: ms,
      startTick: ms[0].measure.startTick,
      endTick: ms[ms.length - 1].measure.endTick,
    };
    y = chordY + height + SYSTEM_GAP;
    return sys;
  });
  const width = Math.max(opts.width, ...systems.map((s) => s.measures[s.measures.length - 1].x + s.measures[s.measures.length - 1].w + SIDE_PAD));
  void chords;
  return { systems, width, height: y, nStrings, ppq: score.ppq };
}
