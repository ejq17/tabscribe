/**
 * ABC notation importer. A compact own parser (abcjs' parseOnly pitch/duration model is awkward under
 * jsdom, and this gives exact control over key-signature accidentals, ties and tuplets).
 * Supported: X/T/C/M/L/Q/K/V fields (also inline [K:] [M:] [L:] [Q:] [V:]), notes, accidentals,
 * octave marks, lengths, rests, chords, ties, broken rhythm, tuplets, multiple voices, bar lines.
 */
import { DEFAULT_PPQ } from '../core';
import type { Note, Score, Track } from '../core';
import { addWarning, makeNote, sortScoreMeta } from './util';
import { pickGuitarTarget } from './midi';

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const WHOLE = DEFAULT_PPQ * 4;

const TONIC_FIFTHS: Record<string, number> = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
};
const MODE_OFFSET: Record<string, number> = { maj: 0, ion: 0, mix: -1, dor: -2, min: -3, m: -3, aeo: -3, phr: -4, lyd: 1, loc: -5 };

interface KeyInfo {
  fifths: number;
  mode: 'major' | 'minor';
  /** letter → alter, includes explicit accidentals */
  acc: Record<string, number>;
}

function parseKey(spec: string): KeyInfo | null {
  let s = spec.trim();
  if (/^none$/i.test(s) || s === '') return s === '' ? null : { fifths: 0, mode: 'major', acc: {} };
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(s);
  if (!m) {
    if (/^HP|^Hp/.test(s)) return { fifths: 2, mode: 'major', acc: { F: 0, C: 0 } };
    return null;
  }
  s = s.slice(m[0].length);
  const tonic = m[1] + m[2];
  let modeStr = m[3].toLowerCase().slice(0, 3);
  // The mode word may be glued to clef keywords etc; only accept known modes.
  if (!(modeStr in MODE_OFFSET)) {
    modeStr = m[3].toLowerCase().startsWith('m') && !m[3].toLowerCase().startsWith('mix') ? 'm' : 'maj';
    if (!/^(m|min|minor|maj|major|ion|mix|dor|phr|lyd|loc|aeo)/i.test(m[3]) ) modeStr = 'maj';
  }
  if (/^m(?!ix|aj)/i.test(m[3])) modeStr = 'min';
  const fifths = (TONIC_FIFTHS[tonic] ?? 0) + (MODE_OFFSET[modeStr] ?? 0);
  const acc: Record<string, number> = {};
  const f = Math.max(-7, Math.min(7, fifths));
  if (f > 0) for (let i = 0; i < f; i++) acc[SHARP_ORDER[i]] = 1;
  if (f < 0) for (let i = 0; i < -f; i++) acc[FLAT_ORDER[i]] = -1;
  // explicit accidentals e.g. "K:D exp _b ^f" or "K:Gmaj ^f"
  const re = /(\^\^|__|\^|_|=)([a-gA-G])/g;
  let em: RegExpExecArray | null;
  while ((em = re.exec(s))) {
    acc[em[2].toUpperCase()] = em[1] === '^^' ? 2 : em[1] === '^' ? 1 : em[1] === '=' ? 0 : em[1] === '_' ? -1 : -2;
  }
  const minorish = ['min', 'm', 'aeo', 'dor', 'phr', 'loc'].includes(modeStr);
  return { fifths: f, mode: minorish ? 'minor' : 'major', acc };
}

function parseFraction(s: string): number | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  const n = Number(s.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface VoiceState {
  id: string;
  name: string;
  notes: Note[];
  cursor: number; // ticks (float)
  barStart: number;
  lastWritten: number;
  barAcc: Map<string, number>; // "G4" → alter within current bar
  tiedPitches: Set<number>;
  key: KeyInfo;
  unit: number; // ticks per default note length
  prev: Note[]; // notes of the previous element (for broken rhythm)
  prevDur: number;
  tuplet: { p: number; q: number; left: number } | null;
}

export function importAbc(text: string): Score {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const score: Score = {
    ppq: DEFAULT_PPQ,
    tracks: [],
    timeSignatures: [],
    keySignatures: [],
    tempos: [],
    meta: { source: 'abc' },
  };

  // Locate first tune
  let i = 0;
  while (i < lines.length && !/^X:/.test(lines[i].trim())) i++;
  if (i >= lines.length) i = 0; // tolerate missing X:
  let tuneCount = 0;
  const tuneLines: string[] = [];
  for (let j = i; j < lines.length; j++) {
    if (/^X:/.test(lines[j].trim())) {
      tuneCount++;
      if (tuneCount > 1) break;
    }
    tuneLines.push(lines[j]);
  }
  // Tune ends at first blank line after the header/body began
  let inBody = false;
  const used: string[] = [];
  for (const raw of tuneLines) {
    if (raw.trim() === '' ) {
      if (inBody) break;
      continue;
    }
    if (/^K:/.test(raw.trim())) inBody = true;
    used.push(raw);
  }
  if (tuneCount > 1 || (tuneLines.length && lines.slice(i + tuneLines.length).some((l) => /^X:/.test(l.trim())))) {
    addWarning(score, 'ABC file contains several tunes; only the first was imported.');
  }

  let meter = { n: 4, d: 4 };
  let unitFrac: number | null = null;
  let headerKey: KeyInfo = { fifths: 0, mode: 'major', acc: {} };
  let sawKey = false;
  let sawRepeat = false;

  const defaultUnit = () => (unitFrac !== null ? unitFrac : meter.n / meter.d < 0.75 ? 1 / 16 : 1 / 8) * WHOLE;

  const voices = new Map<string, VoiceState>();
  const voiceOrder: string[] = [];
  const newVoice = (id: string, name = ''): VoiceState => ({
    id,
    name: name || id,
    notes: [],
    cursor: 0,
    barStart: 0,
    lastWritten: 0,
    barAcc: new Map(),
    tiedPitches: new Set(),
    key: headerKey,
    unit: defaultUnit(),
    prev: [],
    prevDur: 0,
    tuplet: null,
  });
  let cur: VoiceState | null = null;
  const getVoice = (id: string, name?: string): VoiceState => {
    let v = voices.get(id);
    if (!v) {
      v = newVoice(id, name);
      voices.set(id, v);
      voiceOrder.push(id);
    }
    return v;
  };

  const setTempo = (spec: string, tick: number) => {
    const s = spec.replace(/"[^"]*"/g, '').trim();
    let bpm: number | null = null;
    const m = /^(?:([0-9/ ]+)=)?\s*(\d+(?:\.\d+)?)$/.exec(s) ?? /^([0-9/ ]+)=\s*(\d+(?:\.\d+)?)/.exec(s);
    if (m) {
      const per = parseFloat(m[2]);
      let q = 0.25; // beat unit as fraction of whole
      if (m[1]) {
        const parts = m[1].trim().split(/\s+/);
        const sum = parts.reduce((a, p) => a + (parseFraction(p) ?? 0), 0);
        if (sum > 0) q = sum;
      } else {
        q = unitFrac ?? 0.25;
        // plain "Q:120" means 120 beats of the default meter beat (quarter)
        q = 0.25;
      }
      bpm = per * q * 4;
    }
    if (bpm && bpm > 0) {
      const last = score.tempos[score.tempos.length - 1];
      if (last && last.tick === tick) last.bpm = bpm;
      else score.tempos.push({ tick, bpm: Math.round(bpm * 100) / 100 });
    }
  };

  const setMeter = (spec: string, tick: number) => {
    const s = spec.trim();
    let n = meter.n;
    let d = meter.d;
    if (s === 'C') { n = 4; d = 4; }
    else if (s === 'C|') { n = 2; d = 2; }
    else {
      const m = /^\(?([\d+ ]+)\)?\s*\/\s*(\d+)/.exec(s);
      if (m) {
        n = m[1].split('+').reduce((a, x) => a + (parseInt(x, 10) || 0), 0) || 4;
        d = parseInt(m[2], 10) || 4;
      } else if (/^none$/i.test(s)) return;
    }
    meter = { n, d };
    const last = score.timeSignatures[score.timeSignatures.length - 1];
    if (last && last.tick === tick) { last.numerator = n; last.denominator = d; }
    else if (!last || last.numerator !== n || last.denominator !== d) score.timeSignatures.push({ tick, numerator: n, denominator: d });
  };

  const applyKey = (spec: string, tick: number, v: VoiceState | null) => {
    const k = parseKey(spec.replace(/\b(clef|middle|transpose|octave|stafflines)\S*/gi, '').replace(/\b(treble|bass|alto|tenor|perc)\b\S*/gi, ''));
    if (!k) return;
    if (v) v.key = k; else headerKey = k;
    const last = score.keySignatures[score.keySignatures.length - 1];
    if (last && last.tick === tick) { last.fifths = k.fifths; last.mode = k.mode; }
    else if (!last || last.fifths !== k.fifths || last.mode !== k.mode) score.keySignatures.push({ tick, fifths: k.fifths, mode: k.mode });
  };

  const field = (letter: string, value: string, inline: boolean) => {
    const tick = Math.round(cur?.cursor ?? 0);
    switch (letter) {
      case 'T': if (!score.meta.title) score.meta.title = value.trim(); break;
      case 'C': if (!score.meta.composer) score.meta.composer = value.trim(); break;
      case 'M': {
        setMeter(value, tick);
        if (unitFrac === null && cur) cur.unit = defaultUnit();
        break;
      }
      case 'L': {
        const f = parseFraction(value);
        if (f) { unitFrac = f; if (cur) cur.unit = f * WHOLE; for (const v of voices.values()) v.unit = f * WHOLE; }
        break;
      }
      case 'Q': setTempo(value, tick); break;
      case 'K': {
        const first = !sawKey;
        sawKey = true;
        applyKey(value, tick, cur);
        if (first && !inline) {
          const k = parseKey(value.replace(/\b(clef|middle|transpose|octave|stafflines)\S*/gi, ''));
          if (k) {
            headerKey = k;
            for (const v of voices.values()) v.key = k;
          }
        }
        break;
      }
      case 'V': {
        const m = /^(\S+)\s*(.*)$/.exec(value.trim());
        if (m) {
          const nm = /(?:name|nm)\s*=\s*"([^"]*)"/.exec(m[2]);
          cur = getVoice(m[1], nm?.[1]);
          if (nm && cur.name === cur.id) cur.name = nm[1];
        }
        break;
      }
      default: break;
    }
  };

  const ensureVoice = () => {
    if (!cur) cur = getVoice('1');
    return cur;
  };

  const pushNote = (v: ReturnType<typeof ensureVoice>, midi: number, spelling: Note['spelling'], startF: number, durF: number, tie: boolean): Note => {
    const start = Math.round(startF);
    const end = Math.round(startF + durF);
    const n = makeNote(midi, start, Math.max(1, end - start), 90, 0, { spelling });
    if (tie) n.tiedFromPrevious = true;
    v.notes.push(n);
    return n;
  };

  const meterTicks = () => (WHOLE * meter.n) / meter.d;

  const parseBody = (line: string) => {
    let p = 0;
    const L = line.length;
    let brokenPending: number | null = null;
    while (p < L) {
      const ch = line[p];
      if (ch === ' ' || ch === '\t') { p++; continue; }
      if (ch === '%') break;
      if (ch === '\\') { p++; continue; }
      if (ch === '"') { const e = line.indexOf('"', p + 1); p = e < 0 ? L : e + 1; continue; }
      if (ch === '!' ) { const e = line.indexOf('!', p + 1); p = e < 0 ? L : e + 1; continue; }
      if (ch === '+') { const e = line.indexOf('+', p + 1); p = e < 0 ? L : e + 1; continue; }
      if (ch === '{') { const e = line.indexOf('}', p + 1); p = e < 0 ? L : e + 1; continue; }
      if ('.~HLMOPSTuvy'.includes(ch) || ch === ')') { p++; continue; }
      if (ch === '&') { // voice overlay: rewind to bar start
        const v = ensureVoice(); v.cursor = v.barStart; p++; continue;
      }
      if (ch === '(') {
        const m = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(line.slice(p));
        if (m) {
          const pn = parseInt(m[1], 10);
          const compound = meter.d === 8 && meter.n % 3 === 0;
          const defQ: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: compound ? 3 : 2, 6: 2, 7: compound ? 3 : 2, 8: 3, 9: compound ? 3 : 2 };
          const q = m[2] ? parseInt(m[2], 10) : defQ[pn] ?? 2;
          const r = m[3] ? parseInt(m[3], 10) : pn;
          ensureVoice().tuplet = { p: pn, q, left: r };
          p += m[0].length;
        } else p++; // slur open
        continue;
      }
      // Bar lines & repeats
      if (ch === '|' || ch === ':' ) {
        const m = /^(?:\[\||\|\]|\|\||\|:|:\||::|\||:)+/.exec(line.slice(p));
        if (m) {
          if (m[0].includes(':')) sawRepeat = true;
          p += m[0].length;
          const num = /^\d+/.exec(line.slice(p));
          if (num) p += num[0].length;
          const v = ensureVoice();
          v.barStart = v.cursor;
          v.barAcc = new Map();
          continue;
        }
        p++; continue;
      }
      if (ch === '[') {
        const rest = line.slice(p);
        const f = /^\[([A-Za-z]):([^\]]*)\]/.exec(rest);
        if (f) { field(f[1], f[2], true); p += f[0].length; continue; }
        if (rest[1] === '|') { p += 2; const v = ensureVoice(); v.barStart = v.cursor; v.barAcc = new Map(); continue; }
        if (/^\[\d/.test(rest) || /^\[\s*"/.test(rest) && false) { p += 2; continue; }
      }
      // Rests
      if (ch === 'z' || ch === 'Z' || ch === 'x' || ch === 'X') {
        const v = ensureVoice();
        p++;
        const { mult, len } = readLength(line, p);
        p += len;
        let dur = ch === 'z' || ch === 'x' ? v.unit * mult : meterTicks() * (mult || 1);
        if (ch === 'Z' || ch === 'X') dur = meterTicks() * (len ? mult : 1);
        const f = takeTuplet(v);
        dur *= f;
        if (brokenPending !== null) { dur *= brokenPending; brokenPending = null; }
        v.cursor += dur;
        v.prev = [];
        v.tiedPitches = new Set();
        const b = readBroken(line, p);
        if (b) { p += b.len; brokenPending = b.next; adjustPrev(v, b.prev); }
        continue;
      }
      // Chord or single note
      let chordNotes: { midi: number; spelling: Note['spelling']; mult: number; letter: string; oct: number }[] = [];
      let isChord = false;
      const outerStart = p;
      if (ch === '[') {
        const e = line.indexOf(']', p);
        if (e < 0) { p++; continue; }
        isChord = true;
        const inner = line.slice(p + 1, e);
        let ip = 0;
        const v = ensureVoice();
        while (ip < inner.length) {
          const c = inner[ip];
          if (c === '"') { const q = inner.indexOf('"', ip + 1); ip = q < 0 ? inner.length : q + 1; continue; }
          const pn = readPitch(inner, ip, v);
          if (!pn) { ip++; continue; }
          ip = pn.next;
          const ln = readLength(inner, ip);
          ip += ln.len;
          // tie inside chord ("-") ignored here; outer tie handled after
          if (inner[ip] === '-') ip++;
          chordNotes.push({ midi: pn.midi, spelling: pn.spelling, mult: ln.mult, letter: pn.letter, oct: pn.oct });
        }
        p = e + 1;
        const outer = readLength(line, p);
        p += outer.len;
        chordNotes = chordNotes.map((c) => ({ ...c, mult: c.mult * outer.mult }));
        if (/^\[[^\]]*-\s*\]/.test(line.slice(outerStart))) { /* inner ties handled below via tie flag */ }
      } else {
        const v = ensureVoice();
        const pn = readPitch(line, p, v);
        if (!pn) { p++; continue; }
        p = pn.next;
        const ln = readLength(line, p);
        p += ln.len;
        chordNotes = [{ midi: pn.midi, spelling: pn.spelling, mult: ln.mult, letter: pn.letter, oct: pn.oct }];
      }
      if (chordNotes.length === 0) continue;
      const v = ensureVoice();
      const startF = v.cursor;
      let firstDur = v.unit * chordNotes[0].mult;
      const tf = takeTuplet(v);
      firstDur *= tf;
      if (brokenPending !== null) { firstDur *= brokenPending; brokenPending = null; }
      const prevTied = v.tiedPitches;
      const nowTied = new Set<number>();
      const tieAfter = line[p] === '-';
      const made: Note[] = [];
      const hasInnerTie = isChord && /-/.test(line.slice(outerStart, p));
      for (const cn of chordNotes) {
        const dur = (v.unit * cn.mult * tf) * (firstDur / (v.unit * chordNotes[0].mult * tf || 1));
        const tiedIn = prevTied.has(cn.midi);
        made.push(pushNote(v, cn.midi, cn.spelling, startF, isChord ? dur : firstDur, tiedIn));
        if (tieAfter || hasInnerTie) nowTied.add(cn.midi);
      }
      if (tieAfter) p++;
      v.tiedPitches = nowTied;
      v.cursor = startF + firstDur;
      v.prev = made;
      v.prevDur = firstDur;
      const b = readBroken(line, p);
      if (b) {
        // consume run of > or <
        p += b.len;
        adjustPrev(v, b.prev);
        brokenPending = b.next;
      }
    }
  };

  function readLength(s: string, p: number): { mult: number; len: number } {
    const m = /^(\d+)?(\/+)?(\d+)?/.exec(s.slice(p));
    if (!m || m[0] === '') return { mult: 1, len: 0 };
    let mult = 1;
    if (m[1]) mult = parseInt(m[1], 10);
    if (m[2]) {
      if (m[3]) mult = mult / parseInt(m[3], 10);
      else mult = mult / Math.pow(2, m[2].length);
    }
    return { mult, len: m[0].length };
  }

  function takeTuplet(v: VoiceState): number {
    if (!v.tuplet) return 1;
    const f = v.tuplet.q / v.tuplet.p;
    v.tuplet.left--;
    if (v.tuplet.left <= 0) v.tuplet = null;
    return f;
  }

  function readBroken(s: string, p: number): { len: number; prev: number; next: number } | null {
    const m = /^(>+|<+)/.exec(s.slice(p));
    if (!m) return null;
    const n = m[0].length;
    const dotted = 2 - Math.pow(2, -n); // 1.5, 1.75...
    const short = Math.pow(2, -n);
    return m[0][0] === '>' ? { len: n, prev: dotted, next: short } : { len: n, prev: short, next: dotted };
  }

  function adjustPrev(v: VoiceState, factor: number) {
    if (!v.prev.length) {
      return;
    }
    const oldDur = v.prevDur;
    const newDur = oldDur * factor;
    for (const n of v.prev) n.duration = Math.max(1, Math.round(newDur));
    v.cursor = v.cursor - oldDur + newDur;
    v.prevDur = newDur;
  }

  function readPitch(s: string, p: number, v: VoiceState): { midi: number; spelling: Note['spelling']; next: number; letter: string; oct: number } | null {
    let q = p;
    let acc: number | null = null;
    const am = /^(\^\^|__|\^|_|=)/.exec(s.slice(q));
    if (am) {
      acc = am[1] === '^^' ? 2 : am[1] === '^' ? 1 : am[1] === '=' ? 0 : am[1] === '_' ? -1 : -2;
      q += am[1].length;
    }
    const c = s[q];
    if (!c || !/[A-Ga-g]/.test(c)) return null;
    q++;
    const letter = c.toUpperCase();
    let oct = c === c.toUpperCase() ? 4 : 5;
    while (s[q] === "'" || s[q] === ',') { oct += s[q] === "'" ? 1 : -1; q++; }
    const key = `${letter}${oct}`;
    let alter: number;
    if (acc !== null) {
      alter = acc;
      v.barAcc.set(key, acc);
    } else if (v.barAcc.has(key)) alter = v.barAcc.get(key)!;
    else alter = v.key.acc[letter] ?? 0;
    const midi = (oct + 1) * 12 + LETTER_PC[letter] + alter;
    const spelling = { step: letter as 'C', alter: Math.max(-2, Math.min(2, alter)), octave: oct };
    return { midi, spelling, next: q, letter, oct };
  }

  // ---- main loop over lines
  for (const raw of used) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (t === '' || t.startsWith('%')) continue;
    const fm = /^([A-Za-z]):\s?(.*)$/.exec(t);
    if (fm) {
      const letter = fm[1];
      if (letter !== 'X' && 'TCMLQKV'.includes(letter)) field(letter, fm[2].replace(/\s%.*$/, ''), false);
      continue; // other info fields (w:, W:, N:, ...) ignored
    }
    if (!sawKey) continue; // stray header text
    parseBody(line);
  }

  // ---- assemble
  if (voiceOrder.length === 0) addWarning(score, 'ABC tune contains no notes.');
  const tracks: Track[] = voiceOrder.map((id) => {
    const v = voices.get(id)!;
    v.notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    return { id: `v${id}`, name: v.name === id && voiceOrder.length === 1 ? (score.meta.title ?? 'Melody') : v.name, program: 0, notes: v.notes };
  });
  score.tracks = tracks.filter((t) => t.notes.length > 0);
  if (!score.timeSignatures.length || score.timeSignatures[0].tick > 0) score.timeSignatures.unshift({ tick: 0, numerator: meter.n, denominator: meter.d });
  if (!score.keySignatures.length || score.keySignatures[0].tick > 0) score.keySignatures.unshift({ tick: 0, fifths: headerKey.fifths, mode: headerKey.mode });
  if (!score.tempos.length || score.tempos[0].tick > 0) score.tempos.unshift({ tick: 0, bpm: 120 });
  if (sawRepeat) addWarning(score, 'Repeat signs are not expanded; the tune is shown as written.');
  pickGuitarTarget(score.tracks, score.tracks.map(() => false));
  sortScoreMeta(score);
  return score;
}
