/**
 * Pure scoring functions for the OMR corpus benchmark: recognized Score vs ground-truth Score.
 * No I/O. `extractTruthMeasures` needs a global DOMParser (jsdom under vitest / installed by corpus-bench).
 */
import type { Note, Score } from '../../src/core/score';
import { keySignatureAt, timeSignatureAt } from '../../src/core/score';

// ---------- types ----------

export interface TruthChord { root: string; quality: string; bass?: string }
export interface TruthMeasure {
  index: number; // 0-based
  startTick: number;
  lengthTick: number;
  fifths: number;
  numerator: number;
  denominator: number;
  chords: TruthChord[];
  slash: boolean;
}
export interface TruthExtras { measures: TruthMeasure[]; clefs: string[] }

export interface PRF { precision: number; recall: number; f1: number; matched: number; truth: number; recognized: number }
export interface Ratio { ok: number; total: number; acc: number | null }

export interface PieceMetrics {
  alignment: 'measure' | 'global';
  alignOffsetTicks: number;
  pitch: PRF; // pitch + onset
  full: PRF; // pitch + onset + duration
  pitchClass: PRF; // pitch class (octave ignored) + onset; diagnoses octave-clef errors
  measures: { truth: number; recognized: number; correct: boolean; absError: number };
  key: Ratio;
  time: Ratio;
  clef: Ratio; // acc null => n/a
  chords: { exact: number | null; root: number | null; measuresWithChords: number; misses: ChordMiss[] }; // null => n/a
  slash: { truth: number; hit: number; falsePos: number; recall: number | null };
}

/** A truth chord measure that did not match exactly. measure is 1-based. */
export interface ChordMiss { measure: number; truth: string; read: string; rootOk: boolean }

export interface ScoreOptions {
  /** onset tolerance in ticks (default ppq/8) */
  onsetTol?: number;
  /** duration tolerance as fraction of truth duration (default 0.25, min ppq/8) */
  durTolFrac?: number;
}

// ---------- notes ----------

export function allNotes(score: Score): Note[] {
  return score.tracks.flatMap((t) => t.notes);
}

export function prf(matched: number, truth: number, recognized: number): PRF {
  const precision = recognized ? matched / recognized : truth === 0 ? 1 : 0;
  const recall = truth ? matched / truth : recognized === 0 ? 1 : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, matched, truth, recognized };
}

interface N { pitch: number; start: number; duration: number }

/** Greedy match: equal pitch, onsets within tol, smallest onset distance first. Returns matched count and pairs. */
export function matchNotes(
  truth: N[],
  rec: N[],
  tol: number,
  durOk?: (t: N, r: N) => boolean,
  pitchClassOnly = false,
): number {
  const key = (p: number) => (pitchClassOnly ? ((p % 12) + 12) % 12 : p);
  const cands: [number, number, number][] = [];
  const byPitch = new Map<number, number[]>();
  rec.forEach((r, j) => { const a = byPitch.get(key(r.pitch)); if (a) a.push(j); else byPitch.set(key(r.pitch), [j]); });
  truth.forEach((t, i) => {
    for (const j of byPitch.get(key(t.pitch)) ?? []) {
      const d = Math.abs(rec[j].start - t.start);
      if (d <= tol && (!durOk || durOk(t, rec[j]))) cands.push([d, i, j]);
    }
  });
  cands.sort((a, b) => a[0] - b[0]);
  const ut = new Set<number>();
  const ur = new Set<number>();
  let m = 0;
  for (const [, i, j] of cands) {
    if (ut.has(i) || ur.has(j)) continue;
    ut.add(i); ur.add(j); m++;
  }
  return m;
}

/** Offset (ticks) to ADD to recognized starts so they best line up with truth: mode of pitch-equal onset differences. */
export function bestOffset(truth: N[], rec: N[], bucket: number): number {
  const byPitch = new Map<number, number[]>();
  for (const r of rec) { const a = byPitch.get(r.pitch); if (a) a.push(r.start); else byPitch.set(r.pitch, [r.start]); }
  const hist = new Map<number, number>();
  for (const t of truth) {
    const rs = byPitch.get(t.pitch);
    if (!rs) continue;
    for (const s of rs) {
      const k = Math.round((t.start - s) / bucket);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  let best = 0; let bc = 0;
  for (const [k, c] of hist) if (c > bc || (c === bc && Math.abs(k) < Math.abs(best))) { best = k; bc = c; }
  return best * bucket;
}

/** Start-tick grid of `count` measures following the time-signature map (nominal lengths). */
export function measureGrid(score: Score, count: number): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const ts = timeSignatureAt(score, t);
    const len = (score.ppq * 4 * ts.numerator) / ts.denominator;
    out.push({ start: t, length: len });
    t += len;
  }
  return out;
}

export function recognizedMeasureCount(score: Score): number {
  const m = score.meta.omrMeasures;
  if (typeof m === 'number') return m;
  const notes = allNotes(score);
  if (!notes.length) return 0;
  const end = Math.max(...notes.map((n) => n.start + n.duration));
  let t = 0; let c = 0;
  while (t < end && c < 10000) { const ts = timeSignatureAt(score, t); t += (score.ppq * 4 * ts.numerator) / ts.denominator; c++; }
  return c;
}

function rescale(notes: Note[], from: number, to: number): N[] {
  const k = to / from;
  return notes.map((n) => ({ pitch: n.pitch, start: n.start * k, duration: n.duration * k }));
}

// ---------- truth extraction from MusicXML text ----------

const KIND_TO_QUALITY: Record<string, string> = {
  major: '', minor: 'm', augmented: 'aug', diminished: 'dim', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
  'diminished-seventh': 'dim7', 'augmented-seventh': 'aug7', 'half-diminished': 'm7b5', 'major-minor': 'm(maj7)',
  'major-sixth': '6', 'minor-sixth': 'm6', 'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9',
  'dominant-11th': '11', 'dominant-13th': '13', 'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5', none: '',
};

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Root name like "Bb", "F#", "B♭" -> pitch class, or undefined. */
export function rootPitchClass(root: string): number | undefined {
  const m = /^([A-Ga-g])\s*([#♯b♭x]{0,2}|[#♯b♭]*)$/.exec(root.trim());
  if (!m) return undefined;
  let pc = STEP_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : ch === 'x' ? 2 : -1;
  return ((pc % 12) + 12) % 12;
}

/** Canonical quality string for comparison ("min"->"m", "M7"/"Δ"->"maj7", strip spaces/parens, lowercase except none). */
export function normalizeQuality(q: string): string {
  let s = (q ?? '').trim().replace(/[()\s]/g, '').replace(/♭/g, 'b').replace(/♯/g, '#');
  s = s.replace(/^maj$/i, '').replace(/^major$/i, '').replace(/^min(or)?/i, 'm').replace(/^-/, 'm');
  s = s.replace(/^M7$/, 'maj7').replace(/^(Δ|△)7?/, 'maj7').replace(/^ma7/i, 'maj7').replace(/^M9$/, 'maj9');
  s = s.replace(/^mmaj7$/i, 'm(maj7)').replace(/^m\(?maj7\)?$/, 'm(maj7)');
  s = s.replace(/^°7?/, 'dim7').replace(/^o7$/, 'dim7').replace(/^dim$/i, 'dim').replace(/^\+$/, 'aug');
  s = s.replace(/^ø7?$/, 'm7b5');
  return s.toLowerCase().replace('m(maj7)', 'm(maj7)');
}

const lname = (e: Element) => e.localName || e.nodeName;
const kidsOf = (e: Element | null | undefined, n?: string): Element[] =>
  e ? (Array.from(e.children) as Element[]).filter((c) => !n || lname(c) === n) : [];
const kidOf = (e: Element | null | undefined, n: string): Element | undefined => kidsOf(e, n)[0];
const textOf = (e: Element | null | undefined, n: string): string | undefined => kidOf(e, n)?.textContent?.trim();

/** Per-measure truth for the first part: key, time, chords, slash flags, measure lengths; plus clef list across parts. */
export function extractTruthMeasures(xml: string, ppq = 480): TruthExtras {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const parts = Array.from(root.children).filter((c) => lname(c) === 'part');
  const clefs: string[] = [];
  for (const p of parts) {
    for (const cl of Array.from(p.getElementsByTagName('clef'))) {
      const s = textOf(cl, 'sign');
      if (s && !clefs.includes(s + (textOf(cl, 'line') ?? ''))) clefs.push(s + (textOf(cl, 'line') ?? ''));
    }
  }
  const part = parts[0];
  const measures: TruthMeasure[] = [];
  if (!part) return { measures, clefs };
  let divisions = 1; let beats = 4; let beatType = 4; let fifths = 0; let start = 0; let slashOn = false;
  kidsOf(part, 'measure').forEach((m, idx) => {
    let cursor = 0; let extent = 0; let slashHere = slashOn;
    const chords: TruthChord[] = [];
    const implicit = m.getAttribute('implicit') === 'yes';
    for (const el of kidsOf(m)) {
      const n = lname(el);
      if (n === 'attributes') {
        const d = parseFloat(textOf(el, 'divisions') ?? ''); if (d > 0) divisions = d;
        const t = kidOf(el, 'time');
        if (t) {
          const b = textOf(t, 'beats'); const bt = parseInt(textOf(t, 'beat-type') ?? '', 10);
          if (b && bt) { beats = b.split('+').reduce((s, x) => s + (parseInt(x, 10) || 0), 0) || 4; beatType = bt; }
        }
        const k = kidOf(el, 'key'); const f = k ? parseInt(textOf(k, 'fifths') ?? '', 10) : NaN;
        if (!Number.isNaN(f)) fifths = f;
        const ms = kidOf(el, 'measure-style'); const sl = kidOf(ms, 'slash');
        if (sl) { const ty = sl.getAttribute('type'); if (ty === 'start') { slashOn = true; slashHere = true; } else if (ty === 'stop') { slashOn = false; slashHere = true; } }
      } else if (n === 'harmony') {
        const r = kidOf(el, 'root'); const step = textOf(r, 'root-step');
        if (step) {
          const alt = Math.round(parseFloat(textOf(r, 'root-alter') ?? '0')) || 0;
          const kind = kidOf(el, 'kind');
          const kt = kind?.getAttribute('text');
          const quality = kt !== null && kt !== undefined ? kt : (KIND_TO_QUALITY[kind?.textContent?.trim() ?? ''] ?? kind?.textContent?.trim() ?? '');
          const bEl = kidOf(el, 'bass'); const bStep = textOf(bEl, 'bass-step');
          const bAlt = Math.round(parseFloat(textOf(bEl, 'bass-alter') ?? '0')) || 0;
          const bass = bStep ? bStep + (bAlt > 0 ? '#'.repeat(bAlt) : 'b'.repeat(-bAlt)) : undefined;
          chords.push({ root: step + (alt > 0 ? '#'.repeat(alt) : 'b'.repeat(-alt)), quality, ...(bass ? { bass } : {}) });
        }
      } else if (n === 'backup') cursor = Math.max(0, cursor - (parseFloat(textOf(el, 'duration') ?? '0') || 0));
      else if (n === 'forward') { cursor += parseFloat(textOf(el, 'duration') ?? '0') || 0; extent = Math.max(extent, cursor); }
      else if (n === 'note') {
        if (kidOf(el, 'grace')) continue;
        if (!kidOf(el, 'chord')) { cursor += parseFloat(textOf(el, 'duration') ?? '0') || 0; extent = Math.max(extent, cursor); }
        if (kidOf(el, 'notehead')?.textContent?.trim() === 'slash') slashHere = true;
      }
    }
    const nominal = Math.round((divisions * 4 * beats) / beatType);
    const lenDiv = !implicit && extent < nominal ? nominal : extent;
    const lengthTick = Math.round((lenDiv * ppq) / divisions);
    measures.push({ index: idx, startTick: start, lengthTick, fifths, numerator: beats, denominator: beatType, chords, slash: slashHere });
    start += lengthTick;
  });
  return { measures, clefs };
}

// ---------- recognized chords / slash / clef accessors (tolerant of the OMR's meta shape) ----------

export interface RecChord { measure: number; root: string; quality: string; bass?: string; text?: string } // measure 0-based

/** Reads chord labels the OMR may attach: meta.omrChords | meta.chordLabels | meta.chords. Returns null when absent. */
export function extractRecognizedChords(score: Score): RecChord[] | null {
  const raw = (score.meta.omrChords ?? score.meta.chordLabels ?? score.meta.chords) as unknown;
  if (!Array.isArray(raw)) return null;
  const out: RecChord[] = [];
  for (const c of raw as any[]) {
    if (!c) continue;
    let measure: number | undefined;
    if (typeof c.measureIndex === 'number') measure = c.measureIndex;
    else if (typeof c.measure === 'number') measure = c.measure; // OmrChordEntry.measure is 0-based
    else if (typeof c.index === 'number') measure = c.index;
    if (measure === undefined) continue;
    let root: string | undefined = c.chord?.root ?? c.root;
    let quality: string = c.chord?.quality ?? c.quality ?? '';
    if (!root && typeof c.text === 'string') {
      const m = /^([A-G][#b♯♭]?)(.*)$/.exec(c.text.trim());
      if (m) { root = m[1]; quality = m[2]; }
    }
    const bass: string | undefined = c.chord?.bass ?? c.bass;
    if (root) out.push({ measure, root, quality, ...(bass ? { bass } : {}), ...(typeof c.text === 'string' ? { text: c.text } : {}) });
  }
  return out;
}

export function extractRecognizedSlash(score: Score): number[] {
  const raw = score.meta.omrSlashMeasures as { index: number }[] | undefined;
  return Array.isArray(raw) ? raw.map((s) => s.index - 1) : [];
}

const clefName = (sign: string): string => (sign.startsWith('G') ? 'treble' : sign.startsWith('F') ? 'bass' : sign.startsWith('C') ? 'alto' : sign);

// ---------- main scoring ----------

export function scorePiece(truth: Score, rec: Score, extras: TruthExtras, opts: ScoreOptions = {}): PieceMetrics {
  const ppq = truth.ppq;
  const tol = opts.onsetTol ?? ppq / 8;
  const durFrac = opts.durTolFrac ?? 0.25;
  const durOk = (t: N, r: N) => Math.abs(r.duration - t.duration) <= Math.max(ppq / 8, durFrac * t.duration);

  const tN = rescale(allNotes(truth), truth.ppq, ppq);
  const rN = rescale(allNotes(rec), rec.ppq, ppq);

  const truthCount = extras.measures.length || measureGridCountFromNotes(truth);
  const recCount = recognizedMeasureCount(rec);
  const countsAgree = truthCount > 0 && truthCount === recCount;

  let mPitch = 0; let mFull = 0; let mPc = 0; let alignment: 'measure' | 'global' = 'global'; let offset = 0;
  if (countsAgree && extras.measures.length) {
    alignment = 'measure';
    const rg = measureGrid(rec, recCount);
    // bucket notes
    const bucket = (notes: N[], starts: { start: number; length: number }[]) => {
      const b: N[][] = starts.map(() => []);
      for (const n of notes) {
        let lo = 0; let hi = starts.length - 1; let k = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid].start <= n.start + 1e-6) { k = mid; lo = mid + 1; } else hi = mid - 1; }
        b[k].push({ ...n, start: n.start - starts[k].start });
      }
      return b;
    };
    const tb = bucket(tN, extras.measures.map((m) => ({ start: m.startTick, length: m.lengthTick })));
    const rb = bucket(rN, rg);
    for (let i = 0; i < truthCount; i++) {
      mPitch += matchNotes(tb[i], rb[i], tol);
      mFull += matchNotes(tb[i], rb[i], tol, durOk);
      mPc += matchNotes(tb[i], rb[i], tol, undefined, true);
    }
  } else {
    offset = bestOffset(tN, rN, tol);
    const shifted = rN.map((n) => ({ ...n, start: n.start + offset }));
    mPitch = matchNotes(tN, shifted, tol);
    mFull = matchNotes(tN, shifted, tol, durOk);
    mPc = matchNotes(tN, shifted, tol, undefined, true);
  }

  // key / time per truth measure, evaluated at the measure start in the OMR's own grid
  const rg = measureGrid(rec, Math.max(recCount, 0));
  let keyOk = 0; let timeOk = 0;
  const tm = extras.measures;
  tm.forEach((m, i) => {
    const g = rg[i];
    if (!g) return;
    if (keySignatureAt(rec, g.start).fifths === m.fifths) keyOk++;
    const ts = timeSignatureAt(rec, g.start);
    if (ts.numerator === m.numerator && ts.denominator === m.denominator) timeOk++;
  });
  const ratio = (ok: number, total: number): Ratio => ({ ok, total, acc: total ? ok / total : null });

  // clef: only if the OMR exposes meta.omrClefs (string[])
  const recClefs = rec.meta.omrClefs as string[] | undefined;
  let clef: Ratio = { ok: 0, total: 0, acc: null };
  if (Array.isArray(recClefs) && extras.clefs.length) {
    const want = [...new Set(extras.clefs.map(clefName))];
    const have = new Set(recClefs.map((c) => clefName(c)));
    clef = ratio(want.filter((c) => have.has(c)).length, want.length);
  }

  // chords
  const truthChordMeasures = tm.filter((m) => m.chords.length > 0);
  const recChords = extractRecognizedChords(rec);
  let chords: PieceMetrics['chords'] = { exact: null, root: null, measuresWithChords: truthChordMeasures.length, misses: [] };
  const fmtT = (c: TruthChord) => c.root + c.quality + (c.bass ? '/' + c.bass : '');
  const fmtR = (c: RecChord) => c.text ?? c.root + c.quality + (c.bass ? '/' + c.bass : '');
  if (recChords && truthChordMeasures.length) {
    let ex = 0; let rt = 0;
    const misses: ChordMiss[] = [];
    for (const m of truthChordMeasures) {
      const got = recChords.filter((c) => c.measure === m.index);
      const tr = m.chords.map((c) => rootPitchClass(c.root));
      const gr = got.map((c) => rootPitchClass(c.root));
      const rootOk = tr.length === gr.length && tr.every((x, k) => x !== undefined && x === gr[k]);
      if (rootOk) rt++;
      const exact = rootOk && m.chords.every((c, k) => {
        if (normalizeQuality(c.quality) !== normalizeQuality(got[k].quality)) return false;
        const tb = c.bass ? rootPitchClass(c.bass) : undefined; const gb = got[k].bass ? rootPitchClass(got[k].bass!) : undefined;
        return tb === gb;
      });
      if (exact) ex++;
      else misses.push({ measure: m.index + 1, truth: m.chords.map(fmtT).join(' '), read: got.map(fmtR).join(' ') || '(none)', rootOk });
    }
    chords = { exact: ex / truthChordMeasures.length, root: rt / truthChordMeasures.length, measuresWithChords: truthChordMeasures.length, misses };
  }

  // slash
  const truthSlash = new Set(tm.filter((m) => m.slash).map((m) => m.index));
  const recSlash = extractRecognizedSlash(rec);
  const hit = recSlash.filter((i) => truthSlash.has(i)).length;
  const slash = { truth: truthSlash.size, hit, falsePos: recSlash.length - hit, recall: truthSlash.size ? hit / truthSlash.size : null };

  return {
    alignment,
    alignOffsetTicks: offset,
    pitch: prf(mPitch, tN.length, rN.length),
    full: prf(mFull, tN.length, rN.length),
    pitchClass: prf(mPc, tN.length, rN.length),
    measures: { truth: truthCount, recognized: recCount, correct: truthCount === recCount, absError: Math.abs(truthCount - recCount) },
    key: ratio(keyOk, tm.length),
    time: ratio(timeOk, tm.length),
    clef,
    chords,
    slash,
  };
}

function measureGridCountFromNotes(score: Score): number {
  const notes = allNotes(score);
  if (!notes.length) return 0;
  const end = Math.max(...notes.map((n) => n.start + n.duration));
  let t = 0; let c = 0;
  while (t < end && c < 10000) { const ts = timeSignatureAt(score, t); t += (score.ppq * 4 * ts.numerator) / ts.denominator; c++; }
  return c;
}

/** Notes-per-measure dump for inspection: "m3: C4@0.00x1.00 ..." lines. */
export function dumpMeasures(score: Score, count = recognizedMeasureCount(score)): string[] {
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const nm = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const notes = allNotes(score);
  return measureGrid(score, count).map((g, i) => {
    const ns = notes.filter((n) => n.start >= g.start && n.start < g.start + g.length).sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const ts = timeSignatureAt(score, g.start); const k = keySignatureAt(score, g.start);
    return `m${i + 1} [${ts.numerator}/${ts.denominator} key${k.fifths}]: ` + (ns.map((n) => `${nm(n.pitch)}@${((n.start - g.start) / score.ppq).toFixed(2)}x${(n.duration / score.ppq).toFixed(2)}`).join(' ') || '(none)');
  });
}

/** Average of numbers ignoring null/undefined; null when nothing to average. */
export function mean(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Escape bare ampersands (after-youve-gone/score.musicxml has an unescaped "&" in <creator>, which is invalid XML). */
export function sanitizeXml(xml: string): string {
  return xml.replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g, '&amp;');
}
