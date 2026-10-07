import { cloneScore, guitarTrack, measuresOf, midiToName } from '../core';
import type { Score, GuitarConfig, Note, TabPosition } from '../core';

const BEAM = 8;

interface Cand { pos: TabPosition[]; static: number; position: number | null; strings: number[]; effPos: number | null; back: number; total: number }

function positionsFor(pitch: number, g: GuitarConfig): TabPosition[] {
  const out: TabPosition[] = [];
  g.tuning.pitches.forEach((open, string) => {
    const fret = pitch - open;
    if (fret >= g.capo && fret <= g.maxFret) out.push({ string, fret });
  });
  return out;
}

function isFretted(p: TabPosition, g: GuitarConfig): boolean { return p.fret > g.capo; }

function staticCost(all: TabPosition[], g: GuitarConfig): { cost: number; position: number | null; span: number } {
  const fretted = all.filter((p) => isFretted(p, g));
  const frets = fretted.map((p) => p.fret);
  const minF = frets.length ? Math.min(...frets) : null;
  const maxF = frets.length ? Math.max(...frets) : null;
  const span = minF === null || maxF === null ? 0 : maxF - minF;
  let cost = span * 2;
  if (fretted.length) cost += (frets.reduce((a, b) => a + b, 0) / frets.length - g.capo) * 0.3;
  const strs = all.map((p) => p.string);
  const lo = Math.min(...strs), hi = Math.max(...strs);
  let skipped = 0;
  for (let s = lo; s <= hi; s++) if (!strs.includes(s)) skipped++;
  if (all.length > 1) cost += skipped * 0.7;
  for (const f of frets) if (f > 12) cost += 1.5;
  const opens = all.length - fretted.length;
  if (opens > 0 && (minF === null || minF - g.capo <= 5)) cost -= 0.5 * opens;
  return { cost, position: minF, span };
}

/** Enumerate distinct-string assignments of free notes, given fixed (locked) positions. */
function enumerate(cands: TabPosition[][], fixed: TabPosition[], g: GuitarConfig, spanLimit: number): TabPosition[][] {
  const order = cands.map((_, i) => i).sort((a, b) => cands[a].length - cands[b].length);
  const results: TabPosition[][] = [];
  const cur: (TabPosition | null)[] = new Array(cands.length).fill(null);
  const used = new Set<number>(fixed.map((p) => p.string));
  const spanOk = (ps: TabPosition[]): boolean => {
    const fr = ps.filter((p) => isFretted(p, g)).map((p) => p.fret);
    if (fr.length < 2) return true;
    const mn = Math.min(...fr), mx = Math.max(...fr);
    return mx - mn <= (mn >= 7 ? Math.max(spanLimit, 5) : spanLimit);
  };
  const rec = (k: number): void => {
    if (results.length > 4000) return;
    if (k === order.length) { results.push(cur.map((p) => p as TabPosition)); return; }
    const i = order[k];
    for (const p of cands[i]) {
      if (used.has(p.string)) continue;
      cur[i] = p; used.add(p.string);
      const placed = [...fixed, ...cur.filter((q): q is TabPosition => q !== null)];
      if (spanOk(placed)) rec(k + 1);
      used.delete(p.string); cur[i] = null;
    }
  };
  rec(0);
  return results;
}

interface Slice { start: number; notes: Note[] }

export function assignTab(score: Score, guitar: GuitarConfig): Score {
  const out = cloneScore(score);
  const track = guitarTrack(out);
  const warnings = out.meta.warnings ?? [];
  const added: string[] = [];
  if (!track) return out;
  const measures = measuresOf(out);
  const measureOf = (tick: number): number => {
    for (const m of measures) if (tick >= m.startTick && tick < m.endTick) return m.index + 1;
    return measures.length;
  };
  const maxStrings = guitar.tuning.pitches.length;

  // Tied continuations inherit from their source note afterwards.
  const sortedAll = [...track.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const tiedMap = new Map<Note, Note>();
  for (const n of sortedAll) {
    if (!n.tiedFromPrevious) continue;
    const src = sortedAll.find((m) => m !== n && m.pitch === n.pitch && m.start + m.duration === n.start && m.voice === n.voice)
      ?? sortedAll.find((m) => m !== n && m.pitch === n.pitch && m.start < n.start && m.start + m.duration >= n.start);
    if (src) tiedMap.set(n, src);
  }

  // Transpose unplayable notes into range.
  for (const n of sortedAll) {
    if (n.tabLocked && n.tab) continue;
    if (tiedMap.has(n)) continue;
    if (positionsFor(n.pitch, guitar).length > 0) continue;
    const orig = n.pitch;
    let found: number | null = null;
    for (let k = 1; k <= 10 && found === null; k++) {
      for (const sign of [orig > guitar.tuning.pitches[0] ? -1 : 1, orig > guitar.tuning.pitches[0] ? 1 : -1]) {
        if (positionsFor(orig + sign * 12 * k, guitar).length > 0) { found = orig + sign * 12 * k; break; }
      }
    }
    if (found !== null) {
      const oct = Math.abs(found - orig) / 12;
      n.pitch = found;
      delete n.spelling;
      added.push(`Note ${midiToName(orig)} at measure ${measureOf(n.start)} transposed ${found < orig ? 'down' : 'up'} ${oct === 1 ? 'an octave' : oct + ' octaves'}`);
    } else {
      added.push(`Could not find a playable position for ${midiToName(orig)} at measure ${measureOf(n.start)}`);
    }
  }

  // Slices
  const byStart = new Map<number, Note[]>();
  for (const n of sortedAll) {
    if (tiedMap.has(n)) continue;
    let arr = byStart.get(n.start);
    if (!arr) { arr = []; byStart.set(n.start, arr); }
    arr.push(n);
  }
  const slices: Slice[] = [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, notes]) => ({ start, notes }));

  interface Layer { cands: Cand[]; slice: Slice; free: Note[]; fixedNotes: { note: Note; pos: TabPosition }[]; }
  const layers: Layer[] = [];

  for (const slice of slices) {
    const fixedNotes: { note: Note; pos: TabPosition }[] = [];
    let free: Note[] = [];
    for (const n of slice.notes) {
      if (n.tabLocked && n.tab) fixedNotes.push({ note: n, pos: n.tab });
      else if (positionsFor(n.pitch, guitar).length > 0) free.push(n);
    }
    // limit polyphony
    const room = Math.max(0, maxStrings - fixedNotes.length);
    if (free.length > room) {
      free.sort((a, b) => a.pitch - b.pitch);
      const keep: Note[] = [];
      let lo = 0, hi = free.length - 1;
      while (keep.length < room && lo <= hi) {
        keep.push(free[hi--]);
        if (keep.length < room && lo <= hi) keep.push(free[lo++]);
      }
      const dropped = free.filter((n) => !keep.includes(n));
      for (const d of dropped) delete d.tab;
      added.push(`${dropped.length} note${dropped.length > 1 ? 's' : ''} dropped at measure ${measureOf(slice.start)} (more than ${maxStrings} simultaneous notes)`);
      free = keep;
    }
    const fixed = fixedNotes.map((f) => f.pos);
    let assignments: TabPosition[][] = [];
    const tryFree = (list: Note[]): TabPosition[][] => {
      const cl = list.map((n) => positionsFor(n.pitch, guitar));
      for (const lim of [4, 6, 12]) {
        const r = enumerate(cl, fixed, guitar, lim);
        if (r.length) return r;
      }
      return [];
    };
    assignments = free.length ? tryFree(free) : [[]];
    // drop notes one by one if no assignment exists
    while (assignments.length === 0 && free.length > 1) {
      const sorted = [...free].sort((a, b) => a.pitch - b.pitch);
      const victim = sorted[Math.floor(sorted.length / 2)];
      free = free.filter((n) => n !== victim);
      delete victim.tab;
      added.push(`1 note dropped at measure ${measureOf(slice.start)} (no playable fingering)`);
      assignments = tryFree(free);
    }
    if (assignments.length === 0) { assignments = [[]]; for (const n of free) delete n.tab; free = []; }
    const cands: Cand[] = assignments.map((a) => {
      const all = [...fixed, ...a];
      const sc = staticCost(all, guitar);
      return { pos: a, static: sc.cost, position: sc.position, strings: all.map((p) => p.string), effPos: sc.position, back: -1, total: 0 };
    });
    cands.sort((a, b) => a.static - b.static);
    layers.push({ cands: cands.slice(0, BEAM), slice, free, fixedNotes });
  }

  // Viterbi
  const singleNote = (l: Layer): boolean => l.free.length + l.fixedNotes.length === 1;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (i === 0) { for (const c of L.cands) c.total = c.static; continue; }
    const P = layers[i - 1];
    for (const c of L.cands) {
      let bestT = Infinity, bestJ = 0, bestEff: number | null = null;
      P.cands.forEach((pc, j) => {
        let t = pc.total + c.static;
        const cp = c.position;
        const pp = pc.effPos;
        if (cp !== null && pp !== null) t += Math.abs(cp - pp) * 1.0;
        if (singleNote(L) && singleNote(P) && pc.strings.length === 1 && c.strings.length === 1) {
          const ds = Math.abs(pc.strings[0] - c.strings[0]);
          if (ds > 2) t += 2;
          const a = P.free[0] ?? P.fixedNotes[0].note, b = L.free[0] ?? L.fixedNotes[0].note;
          if (ds === 0 && Math.abs(a.pitch - b.pitch) <= 2) t -= 0.3;
        }
        if (t < bestT) { bestT = t; bestJ = j; bestEff = cp !== null ? cp : pc.effPos; }
      });
      c.total = bestT; c.back = bestJ; c.effPos = bestEff;
    }
  }
  // Backtrack
  if (layers.length) {
    let j = 0;
    let bestT = Infinity;
    const last = layers[layers.length - 1];
    last.cands.forEach((c, k) => { if (c.total < bestT) { bestT = c.total; j = k; } });
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const c = L.cands[j];
      L.free.forEach((n, k) => { n.tab = { ...c.pos[k] }; });
      j = c.back;
    }
  }
  // Tied continuations
  for (const [n, src] of tiedMap) if (src.tab) n.tab = { ...src.tab };

  out.meta.warnings = [...new Set([...warnings, ...added])];
  if (out.meta.warnings.length === 0) delete out.meta.warnings;
  return out;
}
