import type { Notehead, RestSym, StaffSymbols, StemInfo } from './types';

/** Duration of one notehead in ticks from head type, stem, flags/beams and dots. */
export function headTicks(h: Notehead, stem: StemInfo | undefined, ppq: number): number {
  const whole = ppq * 4;
  let base: number;
  if (h.hollow) base = stem ? whole / 2 : whole;
  else if (!stem) base = whole / 4;
  else base = whole / 4 / Math.pow(2, Math.min(3, stem.flags));
  return Math.round(applyDots(base, h.dots));
}

export function applyDots(base: number, dots: number): number {
  if (dots <= 0) return base;
  if (dots === 1) return base * 1.5;
  return base * 1.75;
}

export function restTicks(r: RestSym, ppq: number, measureTicks: number): number {
  const whole = ppq * 4;
  let base: number;
  switch (r.kind) {
    case 'whole':
      return measureTicks; // a whole-measure rest fills the measure in any meter
    case 'half':
      base = whole / 2;
      break;
    case 'quarter':
      base = whole / 4;
      break;
    case 'eighth':
      base = whole / 8;
      break;
    default:
      base = whole / 16;
  }
  return Math.round(applyDots(base, r.dots));
}

export interface Cluster {
  heads: Notehead[];
  x: number;
  /** per-head duration (ticks) aligned with `heads` */
  durations: number[];
  /** how far the time cursor advances after this cluster */
  advance: number;
}

/** Group noteheads that sound together: shared stem or x centres within 0.6 staff spaces. */
export function clusterHeads(heads: Notehead[], stems: StemInfo[], d: number, ppq: number): Cluster[] {
  const sorted = [...heads].sort((a, b) => a.cx - b.cx);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].cx - sorted[i].cx > 2.2 * d) break;
      const sameStem = sorted[i].stemId >= 0 && sorted[i].stemId === sorted[j].stemId;
      const sameX = Math.abs(sorted[i].cx - sorted[j].cx) <= 0.6 * d;
      if (sameStem || sameX) union(i, j);
    }
  }
  const groups = new Map<number, Notehead[]>();
  sorted.forEach((h, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(h);
  });
  const out: Cluster[] = [];
  for (const hs of groups.values()) {
    const durations = hs.map((h) => headTicks(h, h.stemId >= 0 ? stems[h.stemId] : undefined, ppq));
    out.push({
      heads: hs,
      x: hs.reduce((s, h) => s + h.cx, 0) / hs.length,
      durations,
      advance: Math.min(...durations),
    });
  }
  return out.sort((a, b) => a.x - b.x);
}

export type RhythmEvent =
  | { kind: 'cluster'; x: number; cluster: Cluster }
  | { kind: 'rest'; x: number; rest: RestSym };

export interface PlacedEvent {
  event: RhythmEvent;
  start: number;
  /** duration scale applied (1 = unchanged) */
  scale: number;
  restTicks?: number;
}

/** Split a staff's symbols into measures (by barline x positions) of rhythm events. */
export function staffMeasures(sym: StaffSymbols, stems: StemInfo[], d: number, ppq: number): RhythmEvent[][] {
  const all: RhythmEvent[] = [];
  for (const c of clusterHeads(sym.heads, stems, d, ppq)) all.push({ kind: 'cluster', x: c.x, cluster: c });
  for (const r of sym.rests) all.push({ kind: 'rest', x: (r.x0 + r.x1) / 2, rest: r });
  all.sort((a, b) => a.x - b.x);
  const out: RhythmEvent[][] = [];
  const nb = sym.barlines.length;
  const slots: RhythmEvent[][] = Array.from({ length: nb + 1 }, () => []);
  for (const e of all) {
    let k = 0;
    for (let i = 0; i < nb; i++) if (e.x >= sym.barlines[i]) k = i + 1;
    slots[k].push(e);
  }
  for (const s of slots) out.push(s);
  // drop a trailing empty measure (the final barline)
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
  return out;
}

export interface Layout {
  placed: PlacedEvent[];
  total: number;
  scaled: boolean;
  /** true when the content did not match the nominal measure length */
  mismatch: boolean;
}

/**
 * Lay out events from the measure start. If the sum of durations does not match `nominal`, durations are scaled
 * proportionally (unless `allowUnderfull` and the measure is merely short, e.g. a pickup or final bar).
 */
export function layoutMeasure(events: RhythmEvent[], nominal: number, ppq: number, allowUnderfull: boolean): Layout {
  const adv = events.map((e) => (e.kind === 'cluster' ? e.cluster.advance : restTicks(e.rest, ppq, nominal)));
  const total = adv.reduce((s, v) => s + v, 0);
  let scale = 1;
  let scaled = false;
  const mismatch = total > 0 && Math.abs(total - nominal) > 1;
  if (mismatch) {
    const wantScale = total > nominal || !allowUnderfull;
    const ratio = nominal / total;
    if (wantScale && ratio >= 0.4 && ratio <= 2.5) {
      scale = ratio;
      scaled = true;
    }
  }
  const placed: PlacedEvent[] = [];
  let cursor = 0;
  events.forEach((e, i) => {
    placed.push({ event: e, start: Math.round(cursor), scale, restTicks: e.kind === 'rest' ? adv[i] : undefined });
    cursor += adv[i] * scale;
  });
  return { placed, total, scaled, mismatch };
}
