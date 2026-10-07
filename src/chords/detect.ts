import { measuresOf, pitchClass, NOTE_NAMES_SHARP, NOTE_NAMES_FLAT, keySignatureAt } from '../core';
import type { Score } from '../core';

export interface ChordEvent {
  tick: number;
  duration: number;
  name: string;
  root: number;
  quality: string;
  bass?: number;
  pitches: number[];
  /** 'omr' = read from the printed score (not inferred from notes) */
  source?: 'omr';
}

/** Chord quality templates: semitone intervals above the root. */
export const CHORD_TEMPLATES: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 2],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 2],
  m9: [0, 3, 7, 10, 2],
  '5': [0, 7],
};

interface Window { start: number; end: number; hist: number[]; bass: number | null; bassWeight: number; pitches: Set<number>; ivs: [number, number][]; pw: Map<number, number>; }
interface Cand { root: number; quality: string; score: number; }

function windowsOf(score: Score, resolution: 'beat' | 'measure' | 'half'): Window[] {
  const out: Window[] = [];
  for (const m of measuresOf(score)) {
    const len = m.endTick - m.startTick;
    let step = len;
    if (resolution === 'beat') step = (score.ppq * 4) / m.timeSignature.denominator;
    else if (resolution === 'half') step = len / 2;
    if (step <= 0) step = len;
    for (let t = m.startTick; t < m.endTick - 1e-6; t += step) {
      out.push({ start: t, end: Math.min(t + step, m.endTick), hist: new Array(12).fill(0), bass: null, bassWeight: 0, pitches: new Set(), ivs: [], pw: new Map() });
    }
  }
  return out;
}

function fillWindows(score: Score, wins: Window[]): void {
  if (wins.length === 0) return;
  const starts = wins.map((w) => w.start);
  for (const tr of score.tracks) {
    for (const n of tr.notes) {
      const nEnd = n.start + Math.max(n.duration, 1);
      // binary search first window with end > n.start
      let lo = 0, hi = wins.length - 1, first = wins.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (wins[mid].end > n.start) { first = mid; hi = mid - 1; } else lo = mid + 1;
      }
      for (let i = first; i < wins.length && starts[i] < nEnd; i++) {
        const w = wins[i];
        const ov = Math.min(nEnd, w.end) - Math.max(n.start, w.start);
        if (ov <= 0) continue;
        w.hist[pitchClass(n.pitch)] += ov;
        w.pitches.add(n.pitch);
        w.ivs.push([Math.max(n.start, w.start), Math.min(nEnd, w.end)]);
        w.pw.set(n.pitch, (w.pw.get(n.pitch) ?? 0) + ov);
        // bass: lowest pitch with meaningful overlap
        if (ov >= (w.end - w.start) * 0.2 || ov >= 1) {
          if (w.bass === null || n.pitch < w.bass) { w.bass = n.pitch; w.bassWeight = ov; }
        }
      }
    }
  }
}

/** Characteristic (colour) interval of qualities that need real support from the notes. */
const CHARACTERISTIC: Record<string, number> = { sus2: 2, sus4: 5, add9: 2, '6': 9, m6: 9, '9': 2, m9: 2 };
const SIMPLE_EXT = new Set(['maj7', 'm7', '7', 'm7b5', 'dim7', 'sus2', 'sus4', 'add9', '6', 'm6', '9', 'm9']);

/** Total time during which 2+ notes sound at once. */
function overlapTime(ivs: [number, number][]): number {
  const ev: [number, number][] = [];
  for (const [a, b] of ivs) { ev.push([a, 1]); ev.push([b, -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let c = 0, last = 0, tot = 0;
  for (const [t, d] of ev) {
    if (c >= 2) tot += t - last;
    c += d; last = t;
  }
  return tot;
}

/** Concentrated-mass evidence for a window without simultaneous notes. */
function concentrated(hist: number[], root: number, quality: string): boolean {
  const ivs = CHORD_TEMPLATES[quality];
  let match = 0, non = 0, present = 0;
  for (let pc = 0; pc < 12; pc++) {
    const inT = ivs.some((i) => (root + i) % 12 === pc);
    if (inT) { match += hist[pc]; if (hist[pc] > 0.02) present++; } else non += hist[pc];
  }
  if (match < 0.75 || non > 0.25 || present < 3) return false;
  const has = (iv: number) => hist[(root + iv) % 12] > 0.02;
  const third = ivs.some((i) => (i === 3 || i === 4 || (quality === 'sus2' && i === 2) || (quality === 'sus4' && i === 5)) && has(i));
  const fifth = ivs.some((i) => (i === 6 || i === 7 || i === 8) && has(i));
  return has(0) && third && fifth;
}

/** Score every (root, quality) against a normalised histogram (sum = 1). */
function scoreCandidates(hist: number[], bassPc: number | null): Cand[] {
  const out: Cand[] = [];
  for (let root = 0; root < 12; root++) {
    for (const [quality, ivs] of Object.entries(CHORD_TEMPLATES)) {
      const tones = new Set(ivs.map((i) => (root + i) % 12));
      let match = 0, non = 0;
      for (let pc = 0; pc < 12; pc++) { if (tones.has(pc)) match += hist[pc]; else non += hist[pc]; }
      let s = match - 0.5 * non;
      // missing tones
      for (const iv of ivs) {
        const pc = (root + iv) % 12;
        if (hist[pc] > 0.02) continue;
        if (iv === 0) s -= 0.45;
        else if (iv === 7) s -= quality === 'dim' || quality === 'aug' || quality === 'm7b5' || quality === 'dim7' ? 0.3 : 0.1;
        else if (quality === 'sus2' || quality === 'sus4' || iv === 3 || iv === 4) s -= 0.3;
        else s -= 0.35; // 6th/7th/9th extension absent
      }
      const ch = CHARACTERISTIC[quality];
      if (ch !== undefined && hist[(root + ch) % 12] < 0.6 * hist[root]) s -= 0.3;
      s -= 0.01 * ivs.length;
      if (bassPc !== null) {
        if (bassPc === root) s += 0.15;
        else if (tones.has(bassPc)) s += 0.04;
        else s -= 0.05;
      }
      out.push({ root, quality, score: s });
    }
  }
  return out;
}

export function chordName(root: number, quality: string, bassPc: number | null, flats: boolean): string {
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  let name = names[root] + quality;
  if (bassPc !== null && bassPc !== root && quality !== '5') {
    const tones = CHORD_TEMPLATES[quality].map((i) => (root + i) % 12);
    if (tones.includes(bassPc)) name += '/' + names[bassPc];
  }
  return name;
}

export function detectChords(score: Score, opts?: { resolution?: 'beat' | 'measure' | 'half' }): ChordEvent[] {
  const wins = windowsOf(score, opts?.resolution ?? 'beat');
  fillWindows(score, wins);
  const events: ChordEvent[] = [];
  let prev: { root: number; quality: string } | null = null;
  for (const w of wins) {
    const total = w.hist.reduce((a, b) => a + b, 0);
    const wlen = w.end - w.start;
    const distinct = w.hist.filter((v) => v > 0).length;
    if (total < wlen * 0.3 || distinct < 2 || wlen <= 0) { prev = null; continue; }
    const hist = w.hist.map((v) => v / total);
    const bassPc = w.bass === null ? null : pitchClass(w.bass);
    const cands = scoreCandidates(hist, bassPc);
    let best = cands[0];
    for (const c of cands) if (c.score > best.score) best = c;
    if (best.score < 0.35) { prev = null; continue; }
    if (SIMPLE_EXT.has(best.quality)) {
      let tri: Cand | null = null;
      for (const c of cands) if ((c.quality === '' || c.quality === 'm') && (!tri || c.score > tri.score)) tri = c;
      if (tri && tri.score >= best.score - 0.15 * Math.abs(best.score)) best = tri;
    }
    if (prev && !(prev.root === best.root && prev.quality === best.quality)) {
      const pc = cands.find((c) => c.root === prev!.root && c.quality === prev!.quality);
      if (pc && pc.score >= best.score - 0.1 * Math.abs(best.score)) best = pc;
    }
    const simultaneous = overlapTime(w.ivs) >= wlen * 0.1;
    if (!simultaneous && !concentrated(hist, best.root, best.quality)) { prev = null; continue; }
    prev = { root: best.root, quality: best.quality };
    // slash bass: sounds >= 50% of the window and >= 3 semitones below everything else
    let slashPc: number | null = null;
    if (w.bass !== null && (w.pw.get(w.bass) ?? 0) >= wlen * 0.5) {
      const others = [...w.pitches].filter((p) => p !== w.bass);
      if (others.every((p) => p - w.bass! >= 3)) slashPc = bassPc;
    }
    const flats = keySignatureAt(score, w.start).fifths < 0;
    const name = chordName(best.root, best.quality, slashPc, flats);
    const hasSlash = name.includes('/');
    const last = events[events.length - 1];
    const pitches = [...w.pitches].sort((a, b) => a - b);
    if (last && last.name === name && last.tick + last.duration === w.start) {
      last.duration += wlen;
      last.pitches = [...new Set([...last.pitches, ...pitches])].sort((a, b) => a - b);
    } else {
      events.push({ tick: w.start, duration: wlen, name, root: best.root, quality: best.quality, bass: hasSlash && slashPc !== null ? slashPc : undefined, pitches });
    }
  }
  return events;
}
