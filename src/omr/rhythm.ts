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

/**
 * Group noteheads that sound together: shared stem, x centres within 0.6 staff spaces, or heads that would physically
 * overlap otherwise (|dx| <= 1.3 d and |dy| <= 1.05 d: a displaced second, or a column whose heads were split by an
 * adjacent arpeggio / roll squiggle that was read as a stem). Duplicate heads at one staff position inside a chord
 * collapse to one, and chord heads that differ only by a missed augmentation dot take the longest duration.
 */
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
      const overlap = Math.abs(sorted[i].cx - sorted[j].cx) <= 1.3 * d && Math.abs(sorted[i].cy - sorted[j].cy) <= 1.05 * d;
      if (sameStem || sameX || overlap) union(i, j);
    }
  }
  const groups = new Map<number, Notehead[]>();
  sorted.forEach((h, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(h);
  });
  const out: Cluster[] = [];
  for (const hs0 of groups.values()) {
    // one head per staff position: drop duplicates (keep the most confident; ties keep the one with a dot)
    const byY = [...hs0].sort((a, b) => a.cy - b.cy);
    const kept: Notehead[] = [];
    for (const h of byY) {
      const dup = kept.findIndex((k) => Math.abs(k.cy - h.cy) < 0.4 * d);
      if (dup < 0) kept.push(h);
      else if (h.confidence > kept[dup].confidence || (h.confidence === kept[dup].confidence && h.dots > kept[dup].dots)) kept[dup] = h;
    }
    const hs = kept.length > 0 ? kept : hs0;
    let durations = hs.map((h) => headTicks(h, h.stemId >= 0 ? stems[h.stemId] : undefined, ppq));
    if (hs.length > 1) {
      // same head type, differing only by dots: the dot is the part that is easily missed
      const factor = (n: number) => (n === 0 ? 1 : n === 1 ? 1.5 : 1.75);
      const undotted = hs.map((h, i) => durations[i] / factor(h.dots));
      const base = undotted[0];
      if (undotted.every((u) => Math.abs(u - base) < 1)) {
        // a second dot is only believed when two heads agree on it (a lone one is a dot of the next sign)
        const twos = hs.filter((h) => h.dots >= 2).length;
        const dots = Math.max(...hs.map((h) => (h.dots >= 2 && twos < 2 ? 1 : h.dots)));
        const v = Math.round(base * factor(dots));
        durations = durations.map(() => v);
      }
    }
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
  | { kind: 'cluster'; x: number; cluster: Cluster; tuplet?: number }
  | { kind: 'rest'; x: number; rest: RestSym; tuplet?: number };

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

/** A key / time-signature change found on a staff; it applies from output measure index `measure` (== length when trailing). */
export interface SigChange {
  measure: number;
  timeSig?: { numerator: number; denominator: number; fromSign?: boolean };
  keyFifths?: number;
  /** a time signature glyph was found here but could not be read (its glyphs are not notes) */
  unreadable?: boolean;
}

export interface StaffLayoutResult {
  measures: RhythmEvent[][];
  /** per output measure: the bar holds chord-slash notation (>= 2 slashes, no notes) */
  slash: boolean[];
  /** signature changes after a double barline (mid-staff or trailing courtesy) */
  changes: SigChange[];
  /** a trailing cell that held only signature junk was dropped (it is not a measure) */
  trailingCourtesy: boolean;
}

export function staffMeasures(sym: StaffSymbols, stems: StemInfo[], d: number, ppq: number): RhythmEvent[][] {
  return staffLayout(sym, stems, d, ppq).measures;
}

/**
 * Split a staff's symbols into measures (by barline x positions) of rhythm events.
 * Multi-measure rests expand to N empty measures; measures made only of chord slashes are emitted empty (and flagged).
 * A key / time signature after the LAST barline (courtesy signature at the end of the staff) is not a measure: its
 * cell is dropped and the change is reported with `measure === measures.length` so the caller carries it to the next
 * system. Changes after a mid-staff double barline are reported with the index of the measure they apply from.
 */
export function staffLayout(sym: StaffSymbols, stems: StemInfo[], d: number, ppq: number): StaffLayoutResult {
  const all: RhythmEvent[] = [];
  const sigs = sym.signatureChanges ?? [];
  const inSig = (x: number) => sigs.some((c) => x >= c.x0 - 0.5 * d && x <= c.x1 + 0.5 * d);
  for (const c of clusterHeads(sym.heads, stems, d, ppq)) all.push({ kind: 'cluster', x: c.x, cluster: c });
  for (const r of sym.rests) all.push({ kind: 'rest', x: (r.x0 + r.x1) / 2, rest: r });
  all.sort((a, b) => a.x - b.x);
  // rest-like fragments left by key / time signature glyphs are not rhythm
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'rest' && inSig(all[i].x)) all.splice(i, 1);
  // events under a triplet bracket / digit sound 3 in the time of 2
  for (const tp of sym.tuplets ?? []) {
    if (tp.n !== 3) continue;
    for (const e of all) if (e.x >= tp.x0 - 0.3 * d && e.x <= tp.x1 + 0.3 * d) e.tuplet = 3;
  }
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
  let trailingCourtesy = false;
  if (closed || slots[n - 1].length === 0) n--;
  else if (nb > 0 && !slots[n - 1].some((e) => e.kind === 'cluster')) {
    // an unterminated last cell with no notes: a courtesy signature (declared, or narrow compared with a real bar)
    const declared = sigs.some((c) => c.barline >= nb - 1);
    const widths: number[] = [];
    for (let i = 1; i < nb; i++) widths.push(sym.barlines[i] - sym.barlines[i - 1]);
    widths.sort((a, b) => a - b);
    const median = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 0;
    const w = right - sym.barlines[nb - 1];
    if (declared || (Number.isFinite(w) && w <= Math.max(9 * d, 0.55 * median))) {
      n--;
      trailingCourtesy = true;
    }
  }
  const out: RhythmEvent[][] = [];
  const slash: boolean[] = [];
  const outStart: number[] = [];
  for (let k = 0; k < n; k++) {
    outStart[k] = out.length;
    let ev = slots[k];
    let isSlash = false;
    if (slashCount[k] >= 2 && !ev.some((e) => e.kind === 'cluster')) {
      ev = [];
      isSlash = true;
    }
    const reps = multi.get(k);
    if (reps && reps > 1 && ev.length === 0 && !isSlash) {
      for (let r = 0; r < reps; r++) {
        out.push([]);
        slash.push(false);
      }
    } else {
      out.push(ev);
      slash.push(isSlash);
    }
  }
  const changes: SigChange[] = [];
  for (const c of sigs) {
    if (!c.timeSig && c.keyFifths === undefined && !c.unreadable) continue;
    const m = outStart[c.barline + 1] ?? out.length;
    changes.push({ measure: m, timeSig: c.timeSig, keyFifths: c.keyFifths, ...(c.unreadable ? { unreadable: true } : {}) });
  }
  return { measures: out, slash, changes, trailingCourtesy };
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
  /** a single low-confidence event was halved / doubled / dotted so the bar adds up (instead of rescaling everything) */
  repaired?: string;
  /** durations were snapped to the nearest standard-duration set that fills the bar (never fractional values) */
  snapped?: boolean;
  /** the bar is shorter than the time signature and was left as read (implied trailing rest), nothing was stretched */
  underfull?: boolean;
}

/** Standard written durations in 16th-note units: 16th .. dotted whole, with single / double dots. */
const STD_UNITS = [1, 2, 3, 4, 6, 7, 8, 12, 14, 16, 24];

/** Nearest standard duration (ticks) to `v`. */
export function snapStandardTicks(v: number, ppq: number): number {
  const g = ppq / 4;
  let best = STD_UNITS[0];
  for (const u of STD_UNITS) if (Math.abs(Math.log(u * g / Math.max(1, v))) < Math.abs(Math.log(best * g / Math.max(1, v)))) best = u;
  return best * g;
}

/** Sum of the written durations of a bar's events (triplet events at 2/3), as used for meter inference. */
export function rawMeasureTotal(events: RhythmEvent[], ppq: number, nominal: number): number {
  let ev = events;
  if (ev.length > 1 && ev.some((e) => e.kind === 'rest' && e.rest.kind === 'whole')) ev = ev.filter((e) => !(e.kind === 'rest' && e.rest.kind === 'whole'));
  let t = 0;
  for (const e of ev) {
    const v = e.kind === 'cluster' ? e.cluster.advance : restTicks(e.rest, ppq, nominal);
    t += e.tuplet === 3 ? Math.round((v * 2) / 3) : v;
  }
  return t;
}

/**
 * Choose one standard duration (16th units) per event so they sum to `target`, minimising the log-ratio change
 * weighted by event reliability (low-confidence events change first). Each event may change by at most a factor of 2.
 * Returns null when no such assignment exists.
 */
function snapToBar(units: number[], weights: number[], target: number): number[] | null {
  const n = units.length;
  if (n === 0 || target <= 0) return null;
  const INF = 1e18;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(target + 1).fill(INF));
  const pick: number[][] = Array.from({ length: n + 1 }, () => new Array(target + 1).fill(0));
  dp[0][0] = 0;
  for (let i = 0; i < n; i++) {
    for (let t = 0; t <= target; t++) {
      if (dp[i][t] >= INF) continue;
      for (const c of STD_UNITS) {
        if (t + c > target) break;
        const ratio = c / Math.max(0.5, units[i]);
        if (ratio > 2.05 || ratio < 0.48) continue;
        const cost = dp[i][t] + weights[i] * Math.abs(Math.log(ratio));
        if (cost < dp[i + 1][t + c]) {
          dp[i + 1][t + c] = cost;
          pick[i + 1][t + c] = c;
        }
      }
    }
  }
  if (dp[n][target] >= INF) return null;
  const res = new Array<number>(n);
  let t = target;
  for (let i = n; i >= 1; i--) {
    res[i - 1] = pick[i][t];
    t -= pick[i][t];
  }
  return res;
}

/**
 * Lay out events from the measure start. Standard durations are used when they fill the measure. Otherwise a
 * triplet group is searched, then a single low-confidence event that can be halved / doubled / dotted. A bar that is
 * still too long is snapped to the nearest set of standard durations (16th .. dotted whole) that fills it; a bar
 * that is too short is left as read (implied trailing rest) unless `allowUnderfull` (pickup / final bar). Durations
 * are never stretched proportionally, so values like 1.25 beats cannot appear. Every onset and duration is on the
 * 16th grid (120 ticks at ppq 480; 80 for triplet groups).
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
  // rest-only bars (chord-hit / slash notation, cue marks) produce no notes: nothing to repair, never a mismatch
  const restOnly = !events.some((e) => e.kind === 'cluster');
  const stdOrig = std.slice();
  // events inside a detected triplet group take 2/3 of their written length on the triplet grid
  const g3a = ppq / 6;
  let explicitTuplet = false;
  events.forEach((e, i) => {
    if (e.tuplet !== 3) return;
    explicitTuplet = true;
    std[i] = Math.round((std[i] * 2) / 3);
    tgt[i] = std[i];
    grids[i] = g3a;
  });
  if (explicitTuplet) total = std.reduce((s, v) => s + v, 0);
  // a bracketed triplet bar that is merely short has implied trailing rests: nothing to repair or rescale
  const impliedRests = explicitTuplet && total < nominal - 1;
  const mismatch0 = !restOnly && total > 0 && Math.abs(total - nominal) > 1 && !impliedRests;
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
  // measure repair: when exactly one event can be halved / doubled / (un)dotted to make the bar add up, prefer that
  // over rescaling every event; skipped when several events (of similar confidence) could explain the error
  let repaired: string | undefined;
  if (mismatch0 && !tuplet && !restOnly && !(allowUnderfull && total < nominal)) {
    const conf = events.map((e) => (e.kind === 'cluster' ? Math.min(...e.cluster.heads.map((h) => h.confidence)) : 0.9));
    const cands: { i: number; nv: number; conf: number; name: string }[] = [];
    std.forEach((v, i) => {
      for (const [f, name] of [[2, 'doubled'], [0.5, 'halved'], [1.5, 'dotted'], [2 / 3, 'undotted']] as const) {
        const nv = Math.round(v * f);
        if (nv < ppq / 4 || nv % (ppq / 8) !== 0 || Math.abs(nv - v * f) > 1) continue;
        if (Math.abs(total - v + nv - nominal) <= 1) cands.push({ i, nv, conf: conf[i], name });
      }
    });
    cands.sort((a, b) => a.conf - b.conf);
    if (cands.length >= 1 && (cands.length === 1 || cands[1].conf - cands[0].conf >= 0.04 || cands.every((c) => c.i === cands[0].i && c.name === cands[0].name))) {
      const c = cands[0];
      std[c.i] = c.nv;
      tgt[c.i] = c.nv;
      total = total - stdOrig[c.i] + c.nv;
      repaired = `event ${c.i + 1} ${c.name}`;
    }
  }
  const scale = 1;
  const scaled = false;
  let clipped = false;
  let snapped = false;
  let underfull = false;
  const mismatchLeft = !restOnly && total > 0 && Math.abs(total - nominal) > 1 && !impliedRests;
  const mismatch = mismatch0 || mismatchLeft;
  if (mismatchLeft) {
    if (total < nominal) {
      // a short bar (pickup / final bar, or events missed): keep the durations as read, never stretch them
      if (!allowUnderfull) underfull = true;
    } else {
      // too long: snap the durations to the nearest standard set that fills the bar
      const g = g16;
      const fixed = events.reduce((sum, e, i) => sum + (e.tuplet === 3 ? tgt[i] : 0), 0);
      const free = events.map((_, i) => i).filter((i) => events[i].tuplet !== 3);
      const target = (nominal - fixed) / g;
      const conf = events.map((e) => (e.kind === 'cluster' ? Math.min(...e.cluster.heads.map((h) => h.confidence)) : 0.9));
      const sol = Number.isInteger(target) ? snapToBar(free.map((i) => tgt[i] / g), free.map((i) => 0.2 + conf[i]), target) : null;
      if (sol) {
        free.forEach((i, k) => (tgt[i] = sol[k] * g));
        snapped = true;
      } else clipped = true;
    }
  }
  const real = tgt.map((v) => v * scale);
  const q = real.map((v, i) => quantizeTicks(v, grids[i]));
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
      scale: stdOrig[i] > 0 ? adv / stdOrig[i] : 1,
      advance: adv,
      grid: grids[i],
      restTicks: e.kind === 'rest' ? adv : undefined,
    });
    cursor += q[i];
  });
  return { placed, total, scaled, mismatch, clipped, tuplet: tuplet || explicitTuplet, repaired, snapped, underfull };
}
