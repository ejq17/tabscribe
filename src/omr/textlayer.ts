/**
 * PDF text layer as the primary source for digitally generated scores.
 *
 * A PDF made by notation software carries every chord symbol, bar number, multi-rest count and tempo mark as real text with an
 * exact position. `pdf.ts` extracts those items (`PdfTextItem`, canvas pixels, baseline-left origin) and this module turns them
 * into the same structures the OCR path produces (`ChordLabel`, `TempoMark`), plus printed measure numbers and the key
 * signature. Pure functions, no DOM: usable from the OMR worker and from tests with synthetic items.
 *
 * A page "has a usable chord text layer" only when at least one item in a chord band parses as a chord symbol; otherwise the
 * caller falls back to OCR for the page (scans, outlined fonts, a hidden OCR layer with nothing chord-like).
 */
import type { ChordLabel } from './chordtext';
import { parseChordExact } from './chordtext/parse';
import { makeUnit, parseTempoText, toQuarterBpm, unitLabel, wordTempo } from './tempo';
import type { BeatUnitName, TempoMark } from './tempo';
import { fromOriginal } from './preprocess';
import type { PageTransform, Staff } from './types';

/** One text run of a PDF page. Canvas pixels of the rendered page; (x, y) is the left end of the baseline. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** pdf.js font id of the run, when known (rehearsal letters are set in another font than chord symbols) */
  font?: string;
}

/** A digit-only text item near a system, in processed-image coordinates. */
export interface PrintedNumber {
  /** left edge */
  x: number;
  /** centre */
  xc: number;
  n: number;
  /** 'below' the last staff of the system (classic bar numbers) or 'above' the first staff (system-start numbers, multi-rest counts) */
  zone: 'above' | 'below';
}

export interface SystemText {
  chords: ChordLabel[];
  tempos: TempoMark[];
  numbers: PrintedNumber[];
  /** key signature counted from accidental glyphs at the start of the staff (negative = flats); undefined when none found */
  keyFifths?: number;
  /**
   * The chord band holds nothing that could not be decoded: every run is plain text, a known notation glyph or a parsed chord.
   * A band with unknown private-use glyphs (a chord accidental drawn with an unmapped font) is not trusted: OCR reads it instead.
   */
  reliable: boolean;
}

export interface PageText {
  /** at least one chord symbol was found in a chord band of this page */
  hasChords: boolean;
  /** several printed bar numbers were found (usable for the measure timeline even when the chords are read by OCR) */
  hasNumbers: boolean;
  /** per system (same index as `PageResult.systems`) */
  systems: SystemText[];
}

export interface Run {
  str: string;
  x0: number;
  x1: number;
  y: number;
  h: number;
  font?: string;
}

/**
 * Glyphs notation fonts use in place of text characters. SMuFL accidentals (MuseScore) and the Sibelius chord-text encodings seen
 * in practice ("¨" flat, "‹" / "Œ" m, "„" a, "ˆ" d, "Š" j: Gm(add9) arrives as "G‹(„ˆˆ9)", Gm(maj7) as "G‹(Œ„Š7)").
 */
const GLYPH_MAP: Record<string, string> = {
  '\uE260': '♭', '\uE261': '', '\uE262': '♯', '\u266D': '♭', '\u266F': '♯', '\u00A8': '♭',
  '\u2039': 'm', '\u0152': 'm', '\u201E': 'a', '\u02C6': 'd', '\u0160': 'j',
};
const decodeGlyphs = (s: string): string => s.replace(/[\uE260-\uE262\u00A8\u2039\u0152\u201E\u02C6\u0160]/g, (c) => GLYPH_MAP[c] ?? c);
/** characters that mark text we cannot read: private-use glyphs (unmapped music-font symbols), control characters, U+FFFD. */
const UNKNOWN_CHARS = /[\p{Cc}\uE000-\uF8FF\uFFFD]/u;

const EMPTY_SYSTEM = (): SystemText => ({ chords: [], tempos: [], numbers: [], reliable: true });

/** Split runs containing inner whitespace into one run per token (x spread by character position); drop whitespace-only runs. */
function tokenize(items: Run[]): Run[] {
  const out: Run[] = [];
  for (const it of items) {
    const s = it.str;
    if (s.trim() === '') continue;
    if (!/\s/.test(s.trim())) {
      out.push({ ...it, str: s.trim() });
      continue;
    }
    const len = Math.max(1, s.length);
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      out.push({
        str: m[0],
        x0: it.x0 + ((it.x1 - it.x0) * m.index) / len,
        x1: it.x0 + ((it.x1 - it.x0) * (m.index + m[0].length)) / len,
        y: it.y,
        h: it.h,
        font: it.font,
      });
    }
  }
  return out;
}

/**
 * Merge runs that belong to one symbol: a root, its accidental and a superscript suffix are often separate runs on slightly
 * different baselines, touching or nearly so. Tokens are merged left to right while the gap is small (a real space between two
 * chords is wider) and the baselines are close.
 */
export function mergeRuns(items: Run[], ss: number): Run[] {
  const toks = tokenize(items).sort((a, b) => a.x0 - b.x0);
  const out: Run[] = [];
  for (const t of toks) {
    // the open run this token continues: nearest to its left, on a close baseline
    let host: Run | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (t.x0 - o.x1 > 0.3 * ss) continue;
      if (t.x0 - o.x1 < -0.6 * ss || Math.abs(t.y - o.y) > 0.7 * ss) continue;
      host = o;
      break;
    }
    if (host) {
      host.str += t.str;
      host.x1 = Math.max(host.x1, t.x1);
      host.y = Math.max(host.y, t.y);
      host.h = Math.max(host.h, t.h);
      if (t.str.length > host.str.length / 2) host.font = host.font ?? t.font;
    } else out.push({ ...t });
  }
  return out;
}

const ACCIDENTAL = /^[♭♯]/;

function beatUnitOf(s: string): { name: BeatUnitName; dotted: boolean } | undefined {
  if (/^\W*q\.?\s*=/.test(s)) return { name: 'quarter', dotted: /^\W*q\./.test(s) };
  const m = /([♩♪]|\u{1D15E}|\u{1D15F}|\u{1D160}|\u{1D15D})(\.?)/u.exec(s);
  if (!m) return undefined;
  const g = m[1];
  const name: BeatUnitName = g === '♪' || g === '\u{1D160}' ? 'eighth' : g === '\u{1D15E}' ? 'half' : g === '\u{1D15D}' ? 'whole' : 'quarter';
  return { name, dotted: m[2] === '.' };
}

/** Printed tempo mark in a text run ("♩ = 156", "q = 120"); undefined when the text is not one. */
export function tempoFromText(str: string, x: number): TempoMark | undefined {
  const p = parseTempoText(str);
  if (!p || !p.hasEquals) return undefined;
  const g = beatUnitOf(str);
  const unit = p.unit ?? (g ? makeUnit(g.name, g.dotted, 'text') : makeUnit('quarter', false, 'assumed'));
  const printed = p.hi !== undefined ? `${p.lo}-${p.hi}` : `${p.lo}`;
  return {
    x,
    text: str,
    kind: 'numeric',
    bpm: toQuarterBpm(p.lo, p.hi, unit),
    printed: { lo: p.lo, hi: p.hi ?? p.lo },
    unit,
    confidence: unit.source === 'assumed' ? 0.6 : 0.95,
    description: `${unitLabel(unit)} = ${printed}`,
  };
}

/**
 * Read the text layer of one page against its detected systems. Coordinates of the result are in processed-image space (what
 * the staves and barlines use). `items` are in original canvas pixels.
 */
export function analyzeTextLayer(
  items: PdfTextItem[],
  geom: { staves: Staff[]; systems: number[][]; transform: PageTransform },
): PageText {
  const { staves, systems, transform: t } = geom;
  const out: PageText = { hasChords: false, hasNumbers: false, systems: systems.map(EMPTY_SYSTEM) };
  if (items.length === 0 || systems.length === 0) return out;
  // processed-space runs
  const runs = items
    .filter((it) => it.str.length > 0 && Number.isFinite(it.x) && Number.isFinite(it.y))
    .map((it) => {
      const a = fromOriginal(t, it.x, it.y);
      const b = fromOriginal(t, it.x + it.w, it.y);
      return { str: decodeGlyphs(it.str), x0: a.x, x1: b.x, y: a.y, h: it.h * t.scale, font: it.font };
    });
  const firstOfSystem = systems.map((sys) => staves[sys[0]]);

  systems.forEach((sys, s) => {
    const st = staves[sys[0]];
    const last = staves[sys[sys.length - 1]];
    const ss = st.staffSpace;
    const top = st.lines[0];
    // free space above: bottom of any staff above (overlapping in x) + a margin
    let limitTop = -Infinity;
    for (let j = 0; j < staves.length; j++) {
      const o = staves[j];
      if (o === st || o.right < st.left || o.left > st.right) continue;
      if (o.bottom <= st.top) limitTop = Math.max(limitTop, o.bottom + 0.6 * o.staffSpace);
    }
    const bandTop = Math.max(limitTop, top - 6.5 * ss);
    const sysOut = out.systems[s];
    const inX = (r: Run) => r.x1 >= st.left && r.x0 <= st.right;

    // ---- chord band: baseline above the first staff (superscript suffixes sit a little higher, tall text may overlap the top line)
    const band = runs.filter((r) => inX(r) && r.y >= bandTop && r.y <= top + 0.5 * ss && r.h <= 3 * ss);
    const merged = mergeRuns(band, ss);
    const parsed: { run: Run; res: NonNullable<ReturnType<typeof parseChordExact>> }[] = [];
    for (const r of merged) {
      const res = parseChordExact(r.str);
      if (res) parsed.push({ run: r, res });
      // text that starts like a chord but does not parse, or holds glyphs we cannot decode: do not trust this band
      else if (UNKNOWN_CHARS.test(r.str) || (/^[A-G]/.test(r.str) && r.str.length > 1 && !isProse(r.str) && (/^[A-G][♭♯b#]?(maj|min|m|M|dim|aug|sus|add|\d|\(|\/|°|ø|\+|-)/.test(r.str) || /^[A-G][♭♯b#]?[^\p{ASCII}♭♯°ø△Δ∆]/u.test(r.str)))) sysOut.reliable = false;
    }
    // single capital letters set larger than the chord text, or in another font, are rehearsal marks
    const multi = parsed.filter((p) => p.run.str.length > 1);
    const hs = multi.map((p) => p.run.h).sort((a, b) => a - b);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    const fonts = new Map<string, number>();
    for (const p of multi) if (p.run.font) fonts.set(p.run.font, (fonts.get(p.run.font) ?? 0) + 1);
    const mainFont = [...fonts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const p of parsed) {
      const { run, res } = p;
      if (/^[A-G]$/.test(run.str) && ((med > 0 && run.h >= 1.3 * med) || (mainFont !== undefined && run.font !== undefined && run.font !== mainFont))) continue;
      sysOut.chords.push({ x: (run.x0 + run.x1) / 2, left: run.x0, text: res.text, chord: res.chord, confidence: 1 });
    }
    sysOut.chords.sort((a, b) => a.x - b.x);
    if (sysOut.chords.length) out.hasChords = true;

    // ---- printed numbers (bar numbers below the staff, system-start numbers / multi-rest counts above it)
    for (const r of runs) {
      const str = r.str.trim();
      if (!/^\d{1,3}$/.test(str) || !inX(r)) continue;
      const n = Number(str);
      let zone: 'above' | 'below' | undefined;
      if (r.y > last.bottom && r.y <= last.bottom + 4.5 * ss) zone = 'below';
      else if (r.y >= bandTop && r.y <= top + 0.5 * ss) zone = 'above';
      if (!zone) continue;
      // below-zone digits belong to the system above them, unless a later system's chord band is nearer
      sysOut.numbers.push({ x: r.x0, xc: (r.x0 + r.x1) / 2, n, zone });
    }
    sysOut.numbers.sort((a, b) => a.x - b.x);

    // ---- key signature: a chain of accidental glyphs from the start of the staff
    const acc = runs
      .filter((r) => ACCIDENTAL.test(r.str.trim()) && r.str.trim().length <= 2 && r.x0 >= st.left && r.y >= st.top - 1.5 * ss && r.y <= st.bottom + 2.5 * ss)
      .sort((a, b) => a.x0 - b.x0);
    if (acc.length && acc[0].x0 - st.left <= 6.5 * ss) {
      const kind = acc[0].str.trim()[0];
      const chain = [acc[0]];
      for (const r of acc.slice(1)) {
        const prev = chain[chain.length - 1];
        if (r.str.trim()[0] !== kind || r.x0 - prev.x0 > 2.2 * ss) break;
        chain.push(r);
      }
      if (chain.length <= 7) sysOut.keyFifths = kind === '♭' ? -chain.length : chain.length;
    }
  });

  const nBars = out.systems.reduce((n, sy) => n + sy.numbers.length, 0);
  out.hasNumbers = nBars >= 3;

  // ---- tempo marks: any run that reads "<note> = <bpm>", attached to the nearest system below it
  for (const r of runs) {
    // "q = 220": the note glyph is its own (short) run just left of the '='
    let text = r.str.trim();
    if (text.startsWith('=')) {
      const g = runs.find((o) => o !== r && o.str.trim().length > 0 && o.str.trim().length <= 2 && Math.abs(o.y - r.y) <= 0.5 * (o.h || 20) && r.x0 - o.x1 >= -2 && r.x0 - o.x1 <= 25);
      if (g) text = `${g.str.trim()} ${text}`;
    }
    const mark = tempoFromText(text, (r.x0 + r.x1) / 2);
    if (!mark) continue;
    let s = -1;
    for (let k = 0; k < systems.length; k++) {
      if (firstOfSystem[k].lines[0] >= r.y - 0.5 * firstOfSystem[k].staffSpace) {
        s = k;
        break;
      }
    }
    if (s < 0) continue;
    const st = firstOfSystem[s];
    // a header above the chord band belongs to the start of the system
    const inBand = r.y >= st.lines[0] - 6.5 * st.staffSpace;
    out.systems[s].tempos.push({ ...mark, x: inBand ? mark.x : st.left + 3.5 * st.staffSpace });
  }
  return out;
}

/** Tempo word ("Allegro", "Moderate jazz waltz") from header text above the first system; only a fallback (kind 'word'). */
export function wordTempoFromText(str: string, x: number): TempoMark | undefined {
  const w = wordTempo(str);
  return w ? { x, text: str, kind: 'word', bpm: w.bpm, confidence: 0.3, description: `'${str.trim()}' (${w.name})` } : undefined;
}

/** Words that start like a chord letter but are prose ("Dal", "Coda", "Fine", "Guitar", "Bass") - they never make a band unreliable. */
function isProse(str: string): boolean {
  return /^[A-G][a-z]{3,}$/.test(str.replace(/[^A-Za-z]/g, '')) && !/(maj|min|dim|aug|sus|add)/.test(str.toLowerCase());
}
