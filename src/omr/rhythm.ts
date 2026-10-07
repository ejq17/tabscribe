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
  /** duration scale applied to the event's standard durations (1 = unchanged) */
  scale: number;
  /** final (quantized) advance in ticks */
  advance: number;
  /** grid (ticks) this event's durations are quantized to */
  grid: number;
  restTicks?: number;
}

/** Quantize a tick value to a grid (never below one grid step). */
export function quantizeTicks(v: number, grid: number): number {
  return Math.max(grid, Math.round(v / grid) * grid);
}

/**
 * Split a staff's symbols into measures (by barline x positions) of rhythm events.
 * Multi-measure rests expand to N empty measures; measures made only of chord slashes are emitted empty.
 */
export function staffMeasures(sym: StaffSymbols, stems: StemInfo[], d: number, ppq: number): RhythmEvent[][] {
  const all: RhythmEvent[] = [];
  for (const c of clusterHeads(sym.heads, stems, d, ppq)) all.push({ kind: 'cluster', x: c.x, cluster: c });
  for (const r of sym.rests) all.push({ kind: 'rest', x: (r.x0 + r.x1) / 2, rest: r });
  all.sort((a, b) => a.x - b.x);
  const nb = sym.barlines.length;
  const slotOf = (x: number): number => {
    let k = 0;
    for (let i = 0; i < nb; i++) if (x >= sym.barlines[i]) k = i + 1;
    return k;
  };
  const slots: RhythmEvent[][] = Array.from({ length: nb + 1 }, () => []);
  for (const e of all) slots[slotOf(e.x)].push(e);
  const slashCount = new Array(nb + 1).fill(0);
  for (const s of sym.slashes ?? []) slashCount[slotOf(s.cx)]++;
  const multi = new Map<number, number>();
  for (const m of sym.multiRests ?? []) multi.set(slotOf((m.x0 + m.x1) / 2), m.count);
  // the slot after the final barline is just the right margin when that barline closes the staff
  const right = sym.staffRight ?? Infinity;
  const closed = nb > 0 && sym.barlines[nb - 1] >= right - 2.5 * d;
  let n = slots.length;
  if (closed || slots[n - 1].length === 0) n--;
  const out: RhythmEvent[][] = [];
  for (let k = 0; k < n; k++) {
    let ev = slots[k];
    if (slashCount[k] >= 2 && !ev.some((e) => e.kind === 'cluster')) ev = [];
    const reps = multi.get(k);
    if (reps && reps > 1 && ev.length === 0) {
      for (let r = 0; r < reps; r++) out.push([]);
    } else out.push(ev);
  }
  return out;
}

export interface Layout {
  placed: PlacedEvent[];
  total: number;
  scaled: boolean;
  /** true when the content did not match the nominal measure length */
  mismatch: boolean;
  /** true when durations could not be fitted and were clipped / padded at the barline */
  clipped: boolean;
  /** the measure contained a triplet group */
  tuplet: boolean;
}

/**
 * Lay out events from the measure start. Standard durations are used when they fill the measure. Otherwise a
 * triplet group is searched; otherwise durations are rescaled proportionally when the factor lies in [0.5, 2.0]
 * (unless `allowUnderfull` and the measure is merely short, e.g. a pickup or final bar). Every onset and duration is
 * quantized to the 16th grid (120 ticks at ppq 480; 80 for triplet groups), so no odd values like 530 or 66 appear.
 */
export function layoutMeasure(events0: RhythmEvent[], nominal: number, ppq: number, allowUnderfull: boolean): Layout {
  // a whole-measure rest next to real events is a misdetection: ignore it
  let events = events0;
  if (events.length > 1 && events.some((e) => e.kind === 'rest' && e.rest.kind === 'whole')) {
    events = events.filter((e) => !(e.kind === 'rest' && e.rest.kind === 'whole'));
  }
  const std = events.map((e) => (e.kind === 'cluster' ? e.cluster.advance : restTicks(e.rest, ppq, nominal)));
  const g16 = ppq / 4;
  const g3 = ppq / 6;
  const grids = std.map(() => g16);
  const tgt = std.map((v) => v);
  let total = std.reduce((s, v) => s + v, 0);
  let tuplet = false;
  const mismatch0 = total > 0 && Math.abs(total - nominal) > 1;
  if (mismatch0) {
    // find three consecutive equal events whose 2:3 compression makes the bar add up
    for (let i = 0; i + 2 < std.length && !tuplet; i++) {
      const a = std[i];
      if (std[i + 1] !== a || std[i + 2] !== a) continue;
      const nt = total - a; // 3a -> 2a
      if (Math.abs(nt - nominal) <= 1) {
        for (let k = i; k < i + 3; k++) {
          tgt[k] = (std[k] * 2) / 3;
          grids[k] = g3;
        }
        total = nt;
        tuplet = true;
      }
    }
  }
  let scale = 1;
  let scaled = false;
  let clipped = false;
  const mismatchLeft = total > 0 && Math.abs(total - nominal) > 1;
  const mismatch = mismatch0 || mismatchLeft;
  if (mismatchLeft) {
    const ratio = nominal / total;
    if (total < nominal && allowUnderfull) {
      // keep as is (pickup bar / final bar)
    } else if (ratio >= 0.5 && ratio <= 2.0) {
      scale = ratio;
      scaled = true;
    } else clipped = true;
  }
  const real = tgt.map((v) => v * scale);
  const q = real.map((v, i) => quantizeTicks(v, grids[i]));
  if (scaled) {
    // distribute the rounding residue so the bar still adds up
    let diff = nominal - q.reduce((s, v) => s + v, 0);
    let guard = 64;
    while (diff !== 0 && guard-- > 0) {
      const sign = diff > 0 ? 1 : -1;
      let best = -1;
      let bestCost = Infinity;
      for (let i = 0; i < q.length; i++) {
        const nv = q[i] + sign * grids[i];
        if (nv < grids[i] || Math.abs(diff) < grids[i]) continue;
        const cost = Math.abs(nv - real[i]) - Math.abs(q[i] - real[i]);
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      if (best < 0) break;
      q[best] += sign * grids[best];
      diff -= sign * grids[best];
    }
  }
  const placed: PlacedEvent[] = [];
  let cursor = 0;
  events.forEach((e, i) => {
    let start = cursor;
    let adv = q[i];
    if (start + adv > nominal && (scaled || clipped || mismatch)) {
      // clip at the barline
      if (start >= nominal) start = Math.max(0, nominal - grids[i]);
      adv = Math.max(grids[i], nominal - start);
      clipped = clipped || start + adv > nominal || cursor >= nominal;
    }
    placed.push({
      event: e,
      start,
      scale: std[i] > 0 ? adv / std[i] : 1,
      advance: adv,
      grid: grids[i],
      restTicks: e.kind === 'rest' ? adv : undefined,
    });
    cursor += q[i];
  });
  return { placed, total, scaled, mismatch, clipped, tuplet };
}
