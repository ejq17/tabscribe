/**
 * Printed tempo marks: parse "♩ = 96", "half note = 100-120" etc. from OCR text, decide the beat unit from the note glyph
 * left of the '=' (geometrically, on the binary) and convert to quarter-note bpm (the unit `Score.tempos` uses).
 * Plain tempo words ("Allegro", "Moderate jazz waltz") map to a default bpm used only when no numeric mark exists.
 */
import type { Binary } from './types';

export type BeatUnitName = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

export interface BeatUnit {
  name: BeatUnitName;
  dotted: boolean;
  /** length of the unit in quarter notes (half = 2, dotted quarter = 1.5) */
  quarters: number;
  source: 'glyph' | 'text' | 'assumed';
}

export interface TempoMark {
  /** word centre x in page pixels */
  x: number;
  /** OCR text the mark was read from */
  text: string;
  kind: 'numeric' | 'word';
  /** quarter-note bpm (midpoint for ranges) */
  bpm: number;
  /** as printed: lo..hi in the printed unit (numeric marks) */
  printed?: { lo: number; hi: number };
  unit?: BeatUnit;
  confidence: number;
  /** short description for the warning line, e.g. "half note = 100-120" */
  description: string;
}

const QUARTERS: Record<BeatUnitName, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25 };

export function makeUnit(name: BeatUnitName, dotted: boolean, source: BeatUnit['source']): BeatUnit {
  return { name, dotted, quarters: QUARTERS[name] * (dotted ? 1.5 : 1), source };
}

export function unitLabel(u: BeatUnit): string {
  return `${u.dotted ? 'dotted ' : ''}${u.name} note`;
}

/** Printed number(s) -> quarter-note bpm using the midpoint of a range. */
export function toQuarterBpm(lo: number, hi: number | undefined, unit: BeatUnit): number {
  const mid = hi !== undefined && hi > lo ? (lo + hi) / 2 : lo;
  return Math.round(mid * unit.quarters * 10) / 10;
}

// ---------------------------------------------------------------------------------------------------------------
// text

export interface ParsedTempoText {
  lo: number;
  hi?: number;
  /** unit named in words ("half note", "quarter", "dotted eighth"), when present */
  unit?: BeatUnit;
  /** a note-like glyph was read (J, d, o, ♩ ...) in front of the number, or the '=' sign itself */
  hasEquals: boolean;
  hasGlyphLetter: boolean;
}

const MIN_BPM = 20;
const MAX_BPM = 400;

function unitFromWords(s: string): BeatUnit | undefined {
  const t = s.toLowerCase();
  const dotted = /dotted|dot\b/.test(t);
  if (/sixteenth|16th/.test(t)) return makeUnit('sixteenth', dotted, 'text');
  if (/eighth|8th|quaver/.test(t)) return makeUnit('eighth', dotted, 'text');
  if (/half|minim/.test(t)) return makeUnit('half', dotted, 'text');
  if (/quarter|crotchet/.test(t)) return makeUnit('quarter', dotted, 'text');
  if (/whole|semibreve/.test(t)) return makeUnit('whole', dotted, 'text');
  return undefined;
}

/**
 * Parse tempo-mark text. Accepts "= 100-120", "=100", "- 120" (OCR turned '=' into '-'), "J = 96", "J: 96", "q = 120",
 * "half note = 90". A bare number with neither an '=' like sign nor a note-letter prefix is NOT a tempo (bar / rehearsal numbers).
 * Returns null when no plausible tempo number is found.
 */
export function parseTempoText(raw: string, opts: { allowBare?: boolean } = {}): ParsedTempoText | null {
  const s = raw.replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // number [range]; the separator before it is '=' (possibly misread as '-', ':', '~', '_', '—')
  const m = /(^|[^0-9])([=\-:~_]{1,2})\s*(\d{2,3})(?:\s*(?:-|~|to)\s*(\d{2,3}))?(?!\d)/i.exec(s);
  let sep = m ? m[2] : '';
  let a = m ? Number(m[3]) : NaN;
  let b = m && m[4] ? Number(m[4]) : undefined;
  let prefix = m ? s.slice(0, m.index + m[1].length) : '';
  let glyphLetter = false;
  if (!m) {
    // no separator: accept "J 96" / "d96" / "♩ 120-132" where a note-like glyph letter precedes the number
    const g = /^\W*([JjdDoOqQ♩♪♫])\s*(\d{2,3})(?:\s*-\s*(\d{2,3}))?\s*$/.exec(s);
    const bare = !g && opts.allowBare ? /^\W*(\d{2,3})(?:\s*-\s*(\d{2,3}))?\W*$/.exec(s) : null;
    if (!g && !bare) return null;
    const n = g ?? bare!;
    const ia = g ? 2 : 1;
    a = Number(n[ia]);
    b = n[ia + 1] ? Number(n[ia + 1]) : undefined;
    // a number alone is only plausibly a tempo in the musical range (guards against bar numbers / rehearsal figures)
    if (bare && !(a >= 40 && a <= 300)) return null;
    prefix = g ? g[1] : '';
    glyphLetter = !!g;
    sep = '';
  } else {
    const before = prefix.replace(/[^A-Za-z♩♪♫]/g, '');
    glyphLetter = before.length > 0 && before.length <= 2;
    // "-" alone in the middle of prose ("rit. - 50")? require nothing but glyph junk before it, or an explicit '='
    const wordsBefore = prefix.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).filter((w) => w.length > 2);
    const hasUnitWord = !!unitFromWords(prefix);
    if (sep !== '=' && sep !== '==' && wordsBefore.length > 0 && !hasUnitWord) return null;
  }
  if (!(a >= MIN_BPM && a <= MAX_BPM)) return null;
  if (b !== undefined && (!(b >= MIN_BPM && b <= MAX_BPM) || b <= a)) {
    // "100-20" style truncation or a descending pair: keep the first number only when the second is implausible
    b = undefined;
  }
  return { lo: a, hi: b, unit: unitFromWords(prefix), hasEquals: sep.includes('='), hasGlyphLetter: glyphLetter };
}

/** Default bpm (quarter notes) for plain tempo words; first match in reading order wins. */
export const TEMPO_WORD_BPM: { re: RegExp; bpm: number; name: string }[] = [
  { re: /\blargo\b/, bpm: 50, name: 'Largo' },
  { re: /\blarghetto\b/, bpm: 60, name: 'Larghetto' },
  { re: /\badagio\b/, bpm: 70, name: 'Adagio' },
  { re: /\bandante\b/, bpm: 90, name: 'Andante' },
  { re: /\bmoderato\b/, bpm: 110, name: 'Moderato' },
  { re: /\bmoderate(ly)?\b/, bpm: 110, name: 'Moderate' },
  { re: /\ballegretto\b/, bpm: 120, name: 'Allegretto' },
  { re: /\ballegro\b/, bpm: 130, name: 'Allegro' },
  { re: /\bvivace\b/, bpm: 160, name: 'Vivace' },
  { re: /\bpresto\b/, bpm: 180, name: 'Presto' },
];

/** Tempo word -> default bpm, or null ("Rubato" and other expression words give nothing). */
export function wordTempo(raw: string): { bpm: number; name: string } | null {
  const s = raw.toLowerCase().replace(/[^a-z ]/g, ' ');
  let best: { bpm: number; name: string; at: number } | null = null;
  for (const t of TEMPO_WORD_BPM) {
    const m = t.re.exec(s);
    if (m && (!best || m.index < best.at)) best = { bpm: t.bpm, name: t.name, at: m.index };
  }
  return best ? { bpm: best.bpm, name: best.name } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// glyph

export interface GlyphRegion { x0: number; y0: number; x1: number; y1: number }

export interface BeatGlyph {
  name: BeatUnitName;
  dotted: boolean;
  /** right edge of the glyph (incl. dot) */
  x1: number;
  confidence: number;
}

interface C { x0: number; y0: number; x1: number; y1: number; area: number; px: number[] }

function labelRegion(b: Binary, r: GlyphRegion): C[] {
  const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
  const seen = new Uint8Array(w * h);
  const out: C[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (seen[i] || !b.data[(r.y0 + y) * b.width + r.x0 + x]) continue;
    const c: C = { x0: x, y0: y, x1: x, y1: y, area: 0, px: [] };
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const p = st.pop()!;
      const px = p % w, py = (p - px) / w;
      c.px.push(p);
      c.area++;
      if (px < c.x0) c.x0 = px; if (px > c.x1) c.x1 = px;
      if (py < c.y0) c.y0 = py; if (py > c.y1) c.y1 = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !b.data[(r.y0 + ny) * b.width + r.x0 + nx]) continue;
        seen[ni] = 1;
        st.push(ni);
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * Classify the note glyph (small notehead + stem) found in `region`. `d` is the staff space. The glyph is the stem-bearing
 * component (height ~2.2-4.5 d, width <= 2.2 d) with the greatest right edge that is left of `limitX` (default: whole region).
 */
export function classifyBeatGlyph(b: Binary, region: GlyphRegion, d: number, limitX?: number): BeatGlyph | null {
  const r: GlyphRegion = {
    x0: Math.max(0, Math.floor(region.x0)), y0: Math.max(0, Math.floor(region.y0)),
    x1: Math.min(b.width - 1, Math.ceil(region.x1)), y1: Math.min(b.height - 1, Math.ceil(region.y1)),
  };
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
  const comps = labelRegion(b, r);
  const W = r.x1 - r.x0 + 1;
  const cand = comps.filter((c) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (ch < 2.0 * d || ch > 4.6 * d || cw < 0.5 * d || cw > 2.4 * d) return false;
    if (limitX !== undefined && r.x0 + c.x0 > limitX) return false;
    // needs a stem: some column holds most of the height
    const cols = new Uint16Array(cw);
    for (const p of c.px) cols[(p % W) - c.x0]++;
    return Math.max(...cols) >= 0.7 * ch;
  }).sort((a, c) => c.x1 - a.x1);
  const c = cand[0];
  if (!c) return null;
  const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
  // local bitmap of the component
  const mat = new Uint8Array(cw * ch);
  for (const p of c.px) mat[(Math.floor(p / W) - c.y0) * cw + ((p % W) - c.x0)] = 1;
  const rowCount = (y: number) => { let n = 0; for (let x = 0; x < cw; x++) n += mat[y * cw + x]; return n; };
  // stem column = the column with the most ink
  let sx = 0, best = -1;
  for (let x = 0; x < cw; x++) { let n = 0; for (let y = 0; y < ch; y++) n += mat[y * cw + x]; if (n > best) { best = n; sx = x; } }
  // which end carries the head: more ink in the heavier third
  let top = 0, bot = 0;
  const third = Math.max(1, Math.floor(ch / 3));
  for (let y = 0; y < third; y++) top += rowCount(y);
  for (let y = ch - third; y < ch; y++) bot += rowCount(y);
  const headDown = bot >= top; // head at the bottom (stem up)
  const headH = Math.min(Math.round(1.2 * d), Math.floor(ch * 0.5));
  const ya = headDown ? ch - headH : 0, yb = headDown ? ch - 1 : headH - 1;
  // hollow: background pocket not reachable from outside, inside the head slab
  const PW = cw + 2, PH = ch + 2;
  const bg = new Uint8Array(PW * PH); // 1 = background reached from outside
  const stack: number[] = [0];
  bg[0] = 1;
  const isInk = (x: number, y: number) => x >= 1 && y >= 1 && x <= cw && y <= ch && mat[(y - 1) * cw + (x - 1)] === 1;
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % PW, py = (p - px) / PW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= PW || ny >= PH) continue;
      const ni = ny * PW + nx;
      if (bg[ni] || isInk(nx, ny)) continue;
      bg[ni] = 1;
      stack.push(ni);
    }
  }
  let hole = 0;
  for (let y = ya; y <= yb; y++) for (let x = 0; x < cw; x++) if (!mat[y * cw + x] && !bg[(y + 1) * PW + x + 1]) hole++;
  let headInk = 0;
  for (let y = ya; y <= yb; y++) headInk += rowCount(y);
  const hollow = hole >= Math.max(2, 0.015 * d * d);
  // flags: ink beyond the stem on the free end
  const farA = headDown ? 0 : Math.round(ch * 0.55), farB = headDown ? Math.round(ch * 0.45) : ch;
  const flagCol = Math.min(cw - 1, sx + Math.max(1, Math.round(0.45 * d)));
  let runs = 0;
  if (flagCol > sx) {
    // A flag is WIDE ink at the free end of the stem. A hand-lettered stem leans, so ink right of a fixed column is not enough:
    // a row counts as flag ink when its ink spans more than a stem's width (0.55 d), however the stem leans.
    const flagW = Math.max(3, Math.round(0.55 * d));
    let inRun = false;
    for (let y = farA; y < farB; y++) {
      const any = rowCount(y) >= flagW;
      if (any && !inRun) { runs++; inRun = true; } else if (!any) inRun = false;
    }
  }
  // flag ink must be a real shape, not the head overhanging the stem (heads sit at the other end, so rows differ)
  let name: BeatUnitName;
  if (hollow) name = 'half';
  else if (runs >= 2) name = 'sixteenth';
  else if (runs === 1) name = 'eighth';
  else name = 'quarter';
  // augmentation dot: small blob right of the glyph, near head height
  const headCy = r.y0 + c.y0 + (ya + yb) / 2;
  const dot = comps.find((o) => o !== c
    && o.x0 > c.x1 && o.x0 - c.x1 <= 1.3 * d
    && o.x1 - o.x0 + 1 <= 0.7 * d && o.y1 - o.y0 + 1 <= 0.7 * d && o.area >= 0.02 * d * d
    && Math.abs(r.y0 + (o.y0 + o.y1) / 2 - headCy) <= 0.8 * d);
  const dotted = !!dot;
  const x1 = r.x0 + (dot ? dot.x1 : c.x1);
  const headFill = headInk / Math.max(1, cw * headH);
  const conf = hollow ? 0.9 : headFill > 0.45 ? 0.9 : 0.7;
  return { name, dotted, x1, confidence: conf };
}
