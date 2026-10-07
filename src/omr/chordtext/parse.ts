/**
 * Tolerant chord-symbol grammar for OCR output ("Bbmaj7", "Ebm6/F", "D7b9b5", "Gmadd2", "C9#11", "F6/9" ...).
 * Pure functions, no DOM. Also recognises rehearsal marks and tempo/expression text so they can be excluded.
 */

export interface ParsedChord {
  root: string;
  quality: string;
  bass?: string;
}

export interface ParseResult {
  chord: ParsedChord;
  /** canonical text, e.g. "Ebm6/F" */
  text: string;
  /** 1 = clean parse; each OCR repair costs confidence */
  confidence: number;
}

export type TextKind = 'chord' | 'rehearsal' | 'tempo' | 'unknown';

const ROOT = /^([A-G])([b#]?)/;
const BASS = /^\/([A-G])([b#]?)$/;
// minor marker, type marker, extension, then modifiers
const BODY =
  /^(?<min>min|mi|m(?!aj)|-)?(?<typ>maj|ma|M|Δ|∆|dim|°|o(?=\d|$)|ø|aug|\+)?(?<ext>69|6\/9|13|11|9|7|6|5|4|2)?(?<mods>(?:(?:sus|add)(?:2|4|9|11|13)?|[b#](?:5|9|11|13)|alt)*)$/;

function normalizeSymbols(s: string): string {
  return s
    .replace(/[♭]/g, 'b')
    .replace(/[♯]/g, '#')
    .replace(/[♮]/g, '')
    .replace(/[–−—]/g, '-')
    .replace(/[()\s]/g, '')
    .replace(/[∅Ø]/g, 'ø')
    .replace(/[º˚]/g, '°');
}

function strictParse(s: string): ParsedChord | null {
  const m = ROOT.exec(s);
  if (!m) return null;
  const root = m[1] + m[2];
  let rest = s.slice(m[0].length);
  let bass: string | undefined;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const bm = BASS.exec(rest.slice(slash));
    if (bm) {
      bass = bm[1] + bm[2];
      rest = rest.slice(0, slash);
    }
  }
  // "Bb" followed by something odd: if root accidental made the body invalid, retry treating b as part of the body
  const tryBody = (body: string): string | null => {
    const b = BODY.exec(body);
    if (!b || !b.groups) return null;
    const { min, typ, ext, mods } = b.groups;
    let q = '';
    const isMin = !!min;
    const t = typ === undefined ? '' : /^(maj|ma|M|Δ|∆)$/.test(typ) ? 'maj' : typ === 'o' ? 'dim' : typ === '°' ? 'dim' : typ === '+' ? 'aug' : typ;
    if (t === 'maj' && (isMin ? false : ext !== undefined && !['7', '9', '11', '13'].includes(ext))) return null;
    if (t === 'ø') {
      if (isMin) return null;
      q = 'm7b5' + (ext && ext !== '7' ? '' : '');
    } else {
      if (isMin) q += 'm';
      if (t) q += t;
      if (ext) q += ext;
    }
    if (isMin && t === 'dim') return null;
    if (t === 'maj' && !ext && isMin) q = 'mmaj';
    return q + (mods ?? '');
  };
  let q = tryBody(rest);
  if (q === null && m[2] && !bass) {
    // Maybe the accidental belonged to the body (e.g. "Bb5" as B + b5): only accept if body has a digit after it
    const alt = tryBody(m[2] + rest);
    if (alt !== null && /\d/.test(rest)) return { root: m[1], quality: alt, ...(bass ? { bass } : {}) };
  }
  if (q === null) return null;
  if (q === 'maj') q = 'maj';
  return { root, quality: q, ...(bass ? { bass } : {}) };
}

const fmt = (c: ParsedChord) => `${c.root}${c.quality}${c.bass ? '/' + c.bass : ''}`;

/**
 * OCR confusions, applied one character at a time (positions after the root). Each edit costs confidence.
 * Flat/sharp glyphs are the main victims: b -> p/D/6/8/4, # -> 1/l/4/H/%/h.
 */
const SUBS: Record<string, string[]> = {
  p: ['b'], D: ['b'], '6': ['b'], '8': ['b'], '4': ['b', '#'], '1': ['#'], l: ['#', '1'], I: ['1', '#'], '|': ['1', '#'],
  H: ['#'], h: ['#', 'b'], '%': ['#'], '¥': ['#'], '$': ['#'], ')': ['j'], '}': ['j'], O: ['0'], S: ['5'], '\\': ['/'], '{': ['('],
  rn: ['m'], '+': ['#'], '*': ['#'], '=': ['b'], '£': ['#'],
};
/** characters that may simply be dropped (OCR noise inside a symbol) */
const DROPPABLE = /[^A-Gabdijmnsu0-9/]/;

function neighbours(s: string): { t: string; cost: number }[] {
  const out: { t: string; cost: number }[] = [];
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    for (const r of SUBS[ch] ?? []) out.push({ t: s.slice(0, i) + r + s.slice(i + 1), cost: 0.12 });
    if (DROPPABLE.test(ch) || ch === 'i' || ch === 'a' && s[i - 1] !== 'm') out.push({ t: s.slice(0, i) + s.slice(i + 1), cost: 0.18 });
    // stray digit squeezed between an alteration and the next alteration: "D7#94#5" -> "D7#9#5"
    if (/\d/.test(ch) && i > 1 && /[b#]/.test(s[i + 1] ?? '') && /\d/.test(s[i - 1])) out.push({ t: s.slice(0, i) + s.slice(i + 1), cost: 0.2 });
    if (ch === 'r' && s[i + 1] === 'n') out.push({ t: s.slice(0, i) + 'm' + s.slice(i + 2), cost: 0.12 });
  }
  return out;
}

export function parseChordText(raw: string): ParseResult | null {
  const s0 = normalizeSymbols(raw.trim());
  if (!s0 || s0.length > 16) return null;
  const direct = strictParse(s0);
  if (direct) return { chord: direct, text: fmt(direct), confidence: 1 };
  let best: ParseResult | null = null;
  const seen = new Map<string, number>([[s0, 0]]);
  let frontier: { s: string; cost: number }[] = [{ s: s0, cost: 0 }];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: { s: string; cost: number }[] = [];
    for (const { s, cost } of frontier) {
      for (const n of neighbours(s)) {
        const c = cost + n.cost;
        if (seen.has(n.t) && seen.get(n.t)! <= c) continue;
        seen.set(n.t, c);
        const parsed = strictParse(n.t);
        if (parsed) {
          const conf = Math.max(0.1, 0.9 - c * 1.4 - (/b11|#13|#9b9/.test(parsed.quality) ? 0.1 : 0)); // rare alterations lose ties
          if (!best || conf > best.confidence) best = { chord: parsed, text: fmt(parsed), confidence: conf };
        } else next.push({ s: n.t, cost: c });
      }
    }
    frontier = next;
  }
  return best;
}

/** Split a merged word ("Em9Am9") at capital A-G boundaries when every piece parses; returns the pieces' char spans. */
export function splitChordWord(raw: string): { text: string; start: number; end: number }[] | null {
  const s = normalizeSymbols(raw.trim());
  const cuts: number[] = [];
  for (let i = 1; i < s.length; i++) if (/[A-G]/.test(s[i]) && !/[/]/.test(s[i - 1])) cuts.push(i);
  if (!cuts.length) return null;
  // merge-greedy: try longest-valid pieces left to right
  const out: { text: string; start: number; end: number }[] = [];
  let i = 0;
  const points = [0, ...cuts, s.length];
  while (i < points.length - 1) {
    let ok = false;
    for (let j = points.length - 1; j > i; j--) {
      const piece = s.slice(points[i], points[j]);
      if (parseChordText(piece)) { out.push({ text: piece, start: points[i], end: points[j] }); i = j; ok = true; break; }
    }
    if (!ok) return null;
  }
  return out.length > 1 ? out : null;
}

const TEMPO_WORDS = [
  'rubato', 'rit', 'ritard', 'ritardando', 'rall', 'accel', 'atempo', 'a tempo', 'tempo', 'cresc', 'decresc', 'dim', 'dimin', 'poco', 'molto',
  'swing', 'ballad', 'slow', 'fast', 'moderato', 'andante', 'allegro', 'adagio', 'largo', 'fermata', 'solo', 'fine', 'coda', 'segno', 'tacet',
  'legato', 'staccato', 'pizz', 'arco', 'mute', 'open', 'vamp', 'repeat', 'piano', 'forte', 'mp', 'mf', 'pp', 'ff', 'sfz', 'fp',
  'p', 'f', 'rubatoa', 'espr', 'expr', 'tutti', 'unis', 'dal', 'al', 'seg', 'to', 'last', 'time', 'only', 'bass', 'head',
];

/** Classify text that failed (or should not win over) the chord parse. */
export function classifyNonChord(raw: string): TextKind {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9.\s]/g, '');
  if (!s) return 'unknown';
  if (/^\d{1,3}$/.test(s)) return 'rehearsal';
  if (/^[a-z]$/.test(s) && !'abcdefg'.includes(s)) return 'rehearsal';
  const w = s.replace(/[.\s]/g, '');
  if (TEMPO_WORDS.includes(w)) return 'tempo';
  if (TEMPO_WORDS.some((t) => t.length >= 3 && w.startsWith(t))) return 'tempo';
  if (/^(m|mf|f|p|ff|pp|fff|ppp|mp)$/.test(w)) return 'tempo';
  if (/^[a-z]{4,}$/.test(w) && !/^[a-g](b|#)?(maj|min|dim|aug|sus|add)/.test(w)) return 'tempo'; // long alphabetic words are prose
  return 'unknown';
}
