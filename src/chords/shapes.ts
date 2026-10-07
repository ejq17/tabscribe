import { STANDARD_TUNING, pitchClass } from '../core';
import type { Tuning, TabPosition } from '../core';
import { CHORD_TEMPLATES } from './detect';

/**
 * ChordDiagram. `frets` are ABSOLUTE fret numbers from the nut (like TabPosition),
 * index 0 = highest string, 0 = open, -1 = muted. For a diagram drawn from `baseFret`,
 * the displayed row of a fret is `fret - baseFret + 1`. `barres` use absolute frets and
 * string indices (from <= to, 0 = high string).
 */
export interface ChordDiagram { name: string; frets: number[]; fingers?: number[]; baseFret: number; barres?: { fret: number; from: number; to: number }[] }

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface ParsedChord { root: number; quality: string; bass: number | null }

const QUALITY_ALIASES: Record<string, string> = {
  '': '', maj: '', M: '', major: '',
  m: 'm', min: 'm', '-': 'm', minor: 'm',
  dim: 'dim', o: 'dim', aug: 'aug', '+': 'aug',
  '7': '7', dom7: '7', maj7: 'maj7', M7: 'maj7', '△7': 'maj7', m7: 'm7', min7: 'm7', '-7': 'm7',
  m7b5: 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', dim7: 'dim7', o7: 'dim7',
  sus2: 'sus2', sus4: 'sus4', sus: 'sus4', add9: 'add9', '6': '6', m6: 'm6', '9': '9', m9: 'm9', '5': '5',
};

export function parseChordName(name: string): ParsedChord | null {
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(name.trim());
  if (!m) return null;
  let root = ROOTS[m[1]];
  if (m[2] === '#') root += 1; else if (m[2] === 'b') root -= 1;
  root = pitchClass(root);
  const q = QUALITY_ALIASES[m[3]];
  if (q === undefined) return null;
  let bass: number | null = null;
  if (m[4]) {
    bass = pitchClass(ROOTS[m[4][0]] + (m[4][1] === '#' ? 1 : m[4][1] === 'b' ? -1 : 0));
  }
  return { root, quality: q, bass };
}

function isStandard(t: Tuning): boolean {
  return t.pitches.length === 6 && t.pitches.every((p, i) => p === STANDARD_TUNING.pitches[i]);
}

function parseShape(s: string): number[] {
  // "x32010" is written low E -> high e; multi-digit frets use '.' separators.
  const toks = s.includes('.') ? s.split('.') : s.split('');
  return toks.map((c) => (c === 'x' ? -1 : parseInt(c, 10))).reverse();
}

/** Classic open-position chords (low E -> high e). */
const OPEN: Record<string, string> = {
  C: 'x32010', A: 'x02220', G: '320003', E: '022100', D: 'xx0232',
  Am: 'x02210', Em: '022000', Dm: 'xx0231',
  A7: 'x02020', E7: '020100', D7: 'xx0212', G7: '320001', C7: 'x32310', B7: 'x21202',
  Cmaj7: 'x32000', Fmaj7: 'xx3210', Gmaj7: '320002', Amaj7: 'x02120', Dmaj7: 'xx0222', Emaj7: '021100',
  Am7: 'x02010', Em7: '022030', Dm7: 'xx0211', Bm7: 'x20202',
  Asus2: 'x02200', Dsus2: 'xx0230', Asus4: 'x02230', Dsus4: 'xx0233', Esus4: '022200',
  F: '133211', Cadd9: 'x32030', Gadd9: '320203',
  Em6: '022020', G6: '320000', C6: 'x32210', A6: 'x02222', E6: '022120', D6: 'xx0202',
  A9: 'x02423', E9: '020102', C9: 'x32333', G9: '320201',
  Adim: 'x0121x', Cdim: 'x3454x', Ddim: 'xx0131', Edim: '0120xx',
  Aaug: 'x03221', Caug: 'x32110', Eaug: '032110', Gaug: '321003',
};
// shapes needing two-digit frets, or barre shapes written with '.' separators
const OPEN_DOTTED: Record<string, string> = {
  Bm: 'x.2.4.4.3.2', 'F#m': '2.4.4.2.2.2', Gbm: '2.4.4.2.2.2', Bb: 'x.1.3.3.3.1', 'A#': 'x.1.3.3.3.1', B: 'x.2.4.4.4.2',
  Fm: '1.3.3.1.1.1', Gm: '3.5.5.3.3.3', Cm: 'x.3.5.5.4.3', Bbm: 'x.1.3.3.2.1', 'A#m': 'x.1.3.3.2.1',
};

interface MovableShape { /** which string carries the root: 0 = low E, 1 = A, 2 = D (index from low) */ rootString: number; offsets: (number | null)[] /* low -> high, null = muted */ }
const E_ROOT = 4, A_ROOT = 9, D_ROOT = 2;
const rootPc = [E_ROOT, A_ROOT, D_ROOT];

const x = null;
const SHAPES: Record<string, MovableShape[]> = {
  '': [{ rootString: 0, offsets: [0, 2, 2, 1, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 2, 2, 0] }],
  m: [{ rootString: 0, offsets: [0, 2, 2, 0, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 2, 1, 0] }],
  '7': [{ rootString: 0, offsets: [0, 2, 0, 1, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 0, 2, 0] }],
  maj7: [{ rootString: 0, offsets: [0, 2, 1, 1, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 1, 2, 0] }],
  m7: [{ rootString: 0, offsets: [0, 2, 0, 0, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 0, 1, 0] }],
  sus2: [{ rootString: 1, offsets: [x, 0, 2, 2, 0, 0] }, { rootString: 0, offsets: [0, 2, 4, 4, 0, 0] }],
  sus4: [{ rootString: 0, offsets: [0, 2, 2, 2, 0, 0] }, { rootString: 1, offsets: [x, 0, 2, 2, 3, 0] }],
  dim: [{ rootString: 1, offsets: [x, 0, 1, 2, 1, x] }, { rootString: 2, offsets: [x, x, 0, 1, 3, 1] }],
  aug: [{ rootString: 0, offsets: [0, 3, 2, 1, 1, 0] }, { rootString: 1, offsets: [x, 0, 3, 2, 2, 1] }],
  '5': [{ rootString: 0, offsets: [0, 2, 2, x, x, x] }, { rootString: 1, offsets: [x, 0, 2, 2, x, x] }],
  add9: [{ rootString: 1, offsets: [x, 0, 2, 4, 2, 0] }, { rootString: 0, offsets: [0, 2, 4, 1, 0, 0] }],
  '6': [{ rootString: 0, offsets: [0, 2, 2, 1, 2, 0] }, { rootString: 1, offsets: [x, 0, 2, 2, 2, 2] }],
  m6: [{ rootString: 0, offsets: [0, 2, 2, 0, 2, 0] }, { rootString: 1, offsets: [x, 0, 2, 2, 1, 2] }],
  '9': [{ rootString: 1, offsets: [x, 0, 2, 4, 2, 3] }, { rootString: 0, offsets: [0, 2, 0, 1, 0, 2] }],
  m7b5: [{ rootString: 1, offsets: [x, 0, 1, 0, 1, x] }, { rootString: 0, offsets: [0, 1, 0, 0, x, x] }],
  dim7: [{ rootString: 2, offsets: [x, x, 0, 1, 0, 1] }, { rootString: 1, offsets: [x, 0, 1, 2, 1, 2] }],
  m9: [{ rootString: 1, offsets: [x, 0, -2, 0, 0, x] }],
};

/** Build a diagram from low-to-high-agnostic absolute frets (index 0 = high string). */
export function buildDiagram(name: string, frets: number[]): ChordDiagram {
  const fretted = frets.filter((f) => f > 0);
  const hasOpen = frets.some((f) => f === 0);
  const minF = fretted.length ? Math.min(...fretted) : 1;
  const maxF = fretted.length ? Math.max(...fretted) : 1;
  const baseFret = hasOpen || minF === 1 || maxF <= 4 && minF <= 1 ? 1 : minF;
  const d: ChordDiagram = { name, frets: [...frets], baseFret };
  // barre detection: lowest fretted fret on >=2 strings, no open strings among sounded strings
  if (!hasOpen && fretted.length >= 2) {
    const idx = frets.map((f, i) => (f === minF ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 2) {
      const from = Math.min(...idx), to = Math.max(...idx);
      let ok = true;
      for (let i = from; i <= to; i++) if (frets[i] !== -1 && frets[i] < minF) ok = false;
      if (ok) d.barres = [{ fret: minF, from, to }];
    }
  }
  // simple fingering
  const fingers = frets.map(() => 0);
  const order: number[] = [];
  for (let i = frets.length - 1; i >= 0; i--) if (frets[i] > 0) order.push(i);
  order.sort((a, b) => frets[a] - frets[b] || b - a);
  let finger = 0;
  let lastFret = -1;
  for (const i of order) {
    const barred = d.barres?.some((b) => b.fret === frets[i] && i >= b.from && i <= b.to);
    if (barred) { fingers[i] = 1; if (lastFret !== frets[i]) { finger = Math.max(finger, 1); lastFret = frets[i]; } continue; }
    if (frets[i] !== lastFret) { finger = Math.min(finger + 1, 4); lastFret = frets[i]; }
    fingers[i] = finger;
  }
  if (fretted.length) d.fingers = fingers;
  return d;
}

export function diagramFromVoicing(notes: TabPosition[], name: string): ChordDiagram {
  const n = Math.max(6, ...notes.map((p) => p.string + 1));
  const frets = new Array<number>(n).fill(-1);
  for (const p of notes) {
    // keep the lowest fret if a string is listed twice
    if (frets[p.string] === -1 || p.fret < frets[p.string]) frets[p.string] = p.fret;
  }
  return buildDiagram(name, frets);
}

function lookupStandard(p: ParsedChord, name: string): ChordDiagram | null {
  if (p.bass !== null && p.bass !== p.root) return null;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  for (const nm of [names[p.root], flats[p.root]]) {
    const key = nm + p.quality;
    if (OPEN_DOTTED[key]) return buildDiagram(name, parseShape(OPEN_DOTTED[key]));
    if (OPEN[key]) return buildDiagram(name, parseShape(OPEN[key]));
  }
  const shapes = SHAPES[p.quality];
  if (!shapes) return null;
  let best: { frets: number[]; f: number } | null = null;
  for (const sh of shapes) {
    let f = pitchClass(p.root - rootPc[sh.rootString]);
    if (f === 0 && sh.offsets.some((o) => o !== null && o < 0)) f = 12;
    const lows = sh.offsets.map((o) => (o === null ? -1 : o + f));
    if (lows.some((v) => v > 15)) continue;
    // a shape whose offsets include negatives needs f >= 2
    if (lows.some((v) => v < -1 || (v < 0 && v !== -1))) continue;
    const frets = [...lows].reverse();
    if (!best || f < best.f) best = { frets, f };
  }
  return best ? buildDiagram(name, best.frets) : null;
}

/** Search for a playable voicing in any tuning. */
function searchVoicing(p: ParsedChord, tuning: Tuning, name: string): ChordDiagram | null {
  const ivs = CHORD_TEMPLATES[p.quality];
  if (!ivs) return null;
  const tones = new Set(ivs.map((i) => (p.root + i) % 12));
  const fifth = (p.root + 7) % 12;
  const required = new Set(tones);
  if (ivs.length >= 4 && ivs.includes(7)) required.delete(fifth);
  const n = tuning.pitches.length; // index 0 = high
  const bassPc = p.bass ?? p.root;
  let best: { frets: number[]; score: number } | null = null;
  const maxBase = 12;
  for (let base = 1; base <= maxBase; base++) {
    const opts: number[][] = [];
    for (let s = 0; s < n; s++) {
      const o = [-1];
      for (let f = 0; f <= base + 3; f++) {
        if (f !== 0 && f < base) continue;
        if (f === 0 && base > 4) continue;
        if (tones.has(pitchClass(tuning.pitches[s] + f))) o.push(f);
      }
      opts.push(o);
    }
    const cur = new Array<number>(n).fill(-1);
    const rec = (s: number): void => {
      if (s < 0) { evaluate(cur); return; }
      for (const f of opts[s]) { cur[s] = f; rec(s - 1); }
      cur[s] = -1;
    };
    const evaluate = (frets: number[]): void => {
      const sounded = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
      if (sounded.length < 3) return;
      const have = new Set(sounded.map((i) => pitchClass(tuning.pitches[i] + frets[i])));
      for (const r of required) if (!have.has(r)) return;
      const fretted = frets.filter((f) => f > 0);
      if (fretted.length) { if (Math.max(...fretted) - Math.min(...fretted) > 3) return; }
      const lowest = Math.max(...sounded);
      const lowPc = pitchClass(tuning.pitches[lowest] + frets[lowest]);
      if (p.bass !== null && lowPc !== p.bass) return;
      // finger count
      let fingers = fretted.length;
      if (fretted.length) {
        const mn = Math.min(...fretted);
        const atMin = frets.filter((f) => f === mn).length;
        if (atMin >= 2 && !frets.includes(0)) fingers = fingers - atMin + 1;
      }
      if (fingers > 4) return;
      let score = sounded.length * 1.0;
      if (lowPc === bassPc) score += 4;
      const lo = Math.min(...sounded);
      let innerMutes = 0;
      for (let i = lo; i <= lowest; i++) if (frets[i] === -1) innerMutes++;
      score -= innerMutes * 3;
      score -= (fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0) * 0.3;
      score += frets.filter((f) => f === 0).length * 0.3;
      score -= (fretted.length ? Math.min(...fretted) : 0) * 0.15;
      score -= fingers * 0.2;
      if (!best || score > best.score) best = { frets: [...frets], score };
    };
    rec(n - 1);
  }
  const found = best as { frets: number[]; score: number } | null;
  return found ? buildDiagram(name, found.frets) : null;
}

/**
 * Nearest chord the diagram engine knows for a name it cannot parse (printed symbols like "D7b9b5", "Am11", "Gmadd2"):
 * extensions and alterations are dropped. Returns null when the root cannot be read.
 */
export function simplifyChordName(name: string): string | null {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(name.trim());
  if (!m) return null;
  const [, root, q, bass] = m;
  if (!/^(?:maj|min|dim|aug|add|sus|alt|[mMΔ°ø+\-#b0-9()])*$/.test(q)) return null;
  let out: string;
  if (/dim|°|o7?$/.test(q)) out = /7/.test(q) ? 'dim7' : 'dim';
  else if (/ø|m7b5/.test(q)) out = 'm7b5';
  else if (/aug|\+/.test(q)) out = 'aug';
  else if (/^(maj|M|Δ)/.test(q)) out = 'maj7';
  else if (/^(m|min|-)/.test(q)) out = /6/.test(q) ? 'm6' : /9/.test(q) ? 'm9' : /(7|11|13)/.test(q) ? 'm7' : 'm';
  else if (/sus2/.test(q)) out = 'sus2';
  else if (/sus/.test(q)) out = 'sus4';
  else if (/^9/.test(q)) out = '9';
  else if (/^(7|11|13)/.test(q)) out = '7';
  else if (/^(6|69|6\/9)/.test(q)) out = '6';
  else if (/^5/.test(q)) out = '5';
  else if (/add/.test(q)) out = 'add9';
  else out = '';
  return root + out + (bass ? '/' + bass : '');
}

export function chordDiagram(name: string, tuning: Tuning): ChordDiagram | null {
  const p = parseChordName(name);
  if (!p) {
    const simple = simplifyChordName(name);
    if (!simple || simple === name || !parseChordName(simple)) return null;
    const d = chordDiagram(simple, tuning);
    return d ? { ...d, name } : null;
  }
  if (isStandard(tuning)) {
    const d = lookupStandard(p, name);
    if (d) return d;
  }
  return searchVoicing(p, tuning, name);
}
