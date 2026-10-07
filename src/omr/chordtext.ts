/**
 * Chord-symbol text reader (OCR).
 *
 * Finds text blobs in the band above a staff, OCRs each word with tesseract.js (lazy-loaded; the library, wasm core and
 * `eng` data are only fetched the first time a text blob is found) and parses the result into chord symbols.
 * Rehearsal marks (boxed numbers/letters) and tempo/expression words are detected and EXCLUDED from the chord list.
 *
 * Usage (from the page pipeline):  `const labels = await detectChordLabels(pre.binary, staff, { limitTop })`.
 * `x` is in the coordinates of the binary image passed in (processed page); the assembler maps it to measures by
 * barline x ranges.
 *
 * Browser constraint: tesseract.js spawns its own (nested) Worker, so from inside the OMR Web Worker it needs nested-worker
 * support (Chrome, Firefox, Safari >= 15.5). Where unavailable `detectChordLabels` returns [] and the caller may instead run
 * `findTextWords` in the worker and OCR on the main thread (`ocrWords`). See `configureChordOcr` for asset paths.
 */
import type { Binary, Staff } from './types';
import { encodeGrayPng } from './chordtext/png';
import { otsuThreshold } from './preprocess';
import { classifyNonChord, parseChordText, splitChordWord } from './chordtext/parse';
import type { TextKind } from './chordtext/parse';

export { parseChordText, classifyNonChord, splitChordWord } from './chordtext/parse';
export type { ParsedChord, TextKind } from './chordtext/parse';

export interface ChordLabel {
  measureIndex?: number;
  /** page x (center of the word) in the binary image's coordinates */
  x: number;
  text: string;
  chord: { root: string; quality: string; bass?: string };
  confidence: number;
}

export interface TextWord {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** ink inside the word box, row-major, 1 = ink (word bounding box only) */
  w: number;
  h: number;
  ink: Uint8Array;
  /** boxed (rehearsal mark) */
  boxed: boolean;
  /** grey crop of the word's bounding box (0..255, 255 = paper); present when the word was found on a grey plane */
  grey?: Uint8Array;
}

/** A normalised grey page (255 = paper) in the same coordinates as the binary; used for noisy scans. */
export interface GreyPlane {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ExcludedText {
  x: number;
  text: string;
  kind: TextKind;
}

export interface ChordTextResult {
  chords: ChordLabel[];
  excluded: ExcludedText[];
  /** words found, with raw OCR text (for debugging) */
  raw: { x: number; text: string; confidence: number }[];
}

export interface FindOptions {
  /** upper y limit (bottom of the staff above + margin); text above is ignored */
  limitTop?: number;
  /** ignore words that end left of this x (default: staff.left + 3.5 staff spaces, i.e. the clef area) */
  minX?: number;
  /** grey plane of the page (noisy scans): the chord band is re-thresholded locally from it and words are OCR'd from grey */
  grey?: GreyPlane;
}

interface Comp { x0: number; y0: number; x1: number; y1: number; area: number; touchesBottom: boolean }

/** Connected components (8-neighbour) of the ink inside [y0, y1) over the staff's x extent. */
function components(b: Binary, x0: number, x1: number, y0: number, y1: number): { comps: Comp[] } {
  const w = x1 - x0;
  const h = y1 - y0;
  const labels = new Int32Array(w * h).fill(-1);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x;
    if (labels[idx] >= 0 || !b.data[(y0 + y) * b.width + x0 + x]) continue;
    const id = comps.length;
    const c: Comp = { x0: x, y0: y, x1: x, y1: y, area: 0, touchesBottom: false };
    stack.push(idx);
    labels[idx] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      c.area++;
      if (px < c.x0) c.x0 = px; if (px > c.x1) c.x1 = px;
      if (py < c.y0) c.y0 = py; if (py > c.y1) c.y1 = py;
      if (py === h - 1) c.touchesBottom = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (labels[ni] >= 0 || !b.data[(y0 + ny) * b.width + x0 + nx]) continue;
        labels[ni] = id;
        stack.push(ni);
      }
    }
    comps.push(c);
  }
  return { comps };
}

/**
 * Locate word-sized text blobs in the band above `staff` (about 0.5-5 staff spaces above the top line).
 * Boxed rehearsal marks are returned with `boxed: true` (their frame is part of the ink).
 */
export function findTextWords(b: Binary, staff: Staff, opts: FindOptions = {}): TextWord[] {
  if (opts.grey) {
    const g = findTextWordsGrey(b, staff, opts);
    if (g) return g;
  }
  return findTextWordsBinary(b, staff, opts);
}

/**
 * Noisy scans: the global binarisation shreds small text, so threshold the chord band again from the (lightly smoothed)
 * grey plane with a band-local Otsu cut and attach a grey crop to each word. Returns null when the band has no contrast.
 */
function findTextWordsGrey(b: Binary, staff: Staff, opts: FindOptions): TextWord[] | null {
  const g = opts.grey!;
  if (g.width !== b.width || g.height !== b.height) return null;
  const ss = staff.staffSpace;
  const top = staff.lines[0];
  const bandBottom = Math.round(top - 0.5 * ss);
  let bandTop = Math.round(top - 5 * ss);
  if (opts.limitTop !== undefined) bandTop = Math.max(bandTop, Math.ceil(opts.limitTop));
  bandTop = Math.max(0, bandTop);
  if (bandBottom - bandTop < 0.8 * ss) return [];
  const x0 = Math.max(0, Math.floor(staff.left));
  const x1 = Math.min(b.width, Math.ceil(staff.right));
  const hist = new Uint8Array((x1 - x0) * (bandBottom - bandTop));
  let lo = 255, hi = 0, k = 0;
  for (let y = bandTop; y < bandBottom; y++) for (let x = x0; x < x1; x++) {
    const v = g.data[y * g.width + x];
    hist[k++] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 40) return null;
  // slightly darker than Otsu: at the Otsu cut the letters of small, blurred text fuse into blobs
  const t = Math.max(lo + 30, otsuThreshold(hist) - 32);
  // page-sized plane, only the band rows are filled
  const data = new Uint8Array(b.width * b.height);
  for (let y = bandTop; y < bandBottom; y++) for (let x = x0; x < x1; x++) data[y * b.width + x] = g.data[y * g.width + x] <= t ? 1 : 0;
  const words = findTextWordsBinary({ width: b.width, height: b.height, data }, staff, { ...opts, grey: undefined });
  for (const w of words) {
    const ww = w.x1 - w.x0 + 1, hh = w.y1 - w.y0 + 1;
    const crop = new Uint8Array(ww * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) crop[y * ww + x] = g.data[(w.y0 + y) * g.width + w.x0 + x];
    w.grey = crop;
  }
  return words;
}

function findTextWordsBinary(b: Binary, staff: Staff, opts: FindOptions = {}): TextWord[] {
  const ss = staff.staffSpace;
  const top = staff.lines[0];
  const bandBottom = Math.round(top - 0.5 * ss);
  let bandTop = Math.round(top - 5 * ss);
  if (opts.limitTop !== undefined) bandTop = Math.max(bandTop, Math.ceil(opts.limitTop));
  bandTop = Math.max(0, bandTop);
  if (bandBottom - bandTop < 0.8 * ss) return [];
  const x0 = Math.max(0, Math.floor(staff.left));
  const x1 = Math.min(b.width, Math.ceil(staff.right));
  const { comps } = components(b, x0, x1, bandTop, bandBottom);

  // frames: hollow, roughly square, containing other components
  const isFrame = (c: Comp) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (cw < 0.9 * ss || ch < 0.9 * ss || cw > 4 * ss || ch > 2.8 * ss) return false;
    if (c.area / (cw * ch) > 0.45) return false;
    return comps.some((o) => o !== c && o.x0 > c.x0 && o.x1 < c.x1 && o.y0 > c.y0 && o.y1 < c.y1);
  };
  const frames = comps.filter(isFrame);
  const inFrame = (o: Comp) => frames.some((f) => o !== f && o.x0 >= f.x0 && o.x1 <= f.x1 && o.y0 >= f.y0 && o.y1 <= f.y1);

  const keep: Comp[] = [];
  const boxedSet = new Set<Comp>();
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (frames.includes(c)) { keep.push(c); boxedSet.add(c); continue; }
    if (inFrame(c)) continue; // digit inside a frame: represented by the frame
    if (c.touchesBottom && ch > 0.9 * ss) continue; // stems/notes/ledger stuff connected to the staff area
    if (ch > 2.6 * ss || cw > 3.2 * ss) continue; // slurs, beams, brackets, wide lines
    if (ch < 0.12 * ss && cw > 0.5 * ss) continue; // thin horizontal lines
    if (c.area < 0.04 * ss * ss) continue; // dust
    keep.push(c);
  }
  keep.sort((a, c) => a.x0 - c.x0);

  // cluster into text lines by vertical overlap (keeps key-signature flats / dynamics apart from chord text), then into
  // words by horizontal gap
  const lines: Comp[][] = [];
  const byY = [...keep].sort((a, c) => a.y0 - c.y0);
  const lineSpan: { y0: number; y1: number }[] = [];
  for (const c of byY) {
    let li = -1;
    for (let k = 0; k < lines.length; k++) {
      const L = lineSpan[k];
      const ov = Math.min(L.y1, c.y1) - Math.max(L.y0, c.y0) + 1;
      if (ov > 0.35 * Math.min(L.y1 - L.y0 + 1, c.y1 - c.y0 + 1)) { li = k; break; }
    }
    if (li < 0) { lines.push([c]); lineSpan.push({ y0: c.y0, y1: c.y1 }); }
    else { lines[li].push(c); lineSpan[li].y0 = Math.min(lineSpan[li].y0, c.y0); lineSpan[li].y1 = Math.max(lineSpan[li].y1, c.y1); }
  }
  const groups: Comp[][] = [];
  for (const line of lines) {
    line.sort((a, c) => a.x0 - c.x0);
    let cur: Comp[] = [];
    let maxX = -Infinity;
    for (const c of line) {
      if (cur.length && c.x0 - maxX >= 0.7 * ss) { groups.push(cur); cur = []; }
      cur.push(c);
      maxX = cur.length === 1 ? c.x1 : Math.max(maxX, c.x1);
    }
    if (cur.length) groups.push(cur);
  }
  groups.sort((a, c) => a[0].x0 - c[0].x0);
  const out: TextWord[] = [];
  const minX = opts.minX ?? staff.left + 3.5 * ss;
  for (const g of groups) {
    const gx0 = Math.min(...g.map((c) => c.x0)), gx1 = Math.max(...g.map((c) => c.x1));
    const gy0 = Math.min(...g.map((c) => c.y0)), gy1 = Math.max(...g.map((c) => c.y1));
    const ww = gx1 - gx0 + 1, hh = gy1 - gy0 + 1;
    if (hh < 0.85 * ss || hh > 2.6 * ss) continue; // too small to be text / too tall
    if (ww < 0.3 * ss) continue; // lone specks
    if (x0 + gx1 < minX) continue; // clef / key-signature area
    const ink = new Uint8Array(ww * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) ink[y * ww + x] = b.data[(bandTop + gy0 + y) * b.width + x0 + gx0 + x];
    let inkSum = 0;
    for (let i = 0; i < ink.length; i++) inkSum += ink[i];
    // articulations (^ > .) and other tiny marks; a lone thin letter such as "F" is tall enough to be kept with less ink
    const letterLike = hh >= 1.0 * ss && ww >= 0.4 * ss && inkSum >= 0.3 * ss * ss;
    if (!g.some((c) => boxedSet.has(c)) && inkSum < 0.8 * ss * ss && !letterLike) continue;
    out.push({ x0: x0 + gx0, x1: x0 + gx1, y0: bandTop + gy0, y1: bandTop + gy1, w: ww, h: hh, ink, boxed: g.some((c) => boxedSet.has(c)) });
  }
  return out;
}

/** Render a word to an upscaled, padded, black-on-white grayscale PNG for OCR. */
export function wordToPng(word: TextWord, staffSpace: number, scaleDelta = 0): Uint8Array {
  // target: text cap height ~ 1.2 staff spaces -> about 48 px tall glyphs
  const scale = Math.max(2, Math.min(5, Math.round(56 / Math.max(1, word.h)) + scaleDelta));
  const pad = Math.round(0.5 * staffSpace * scale);
  const W = word.w * scale + 2 * pad;
  const H = word.h * scale + 2 * pad;
  const gray = new Uint8Array(W * H).fill(255);
  if (word.grey) {
    // bilinear upscale of the grey crop with contrast stretched to the full range (ink -> 0, paper -> 255)
    const g = word.grey;
    let lo = 255, hi = 0;
    for (let i = 0; i < g.length; i++) { if (g[i] < lo) lo = g[i]; if (g[i] > hi) hi = g[i]; }
    const span = Math.max(1, hi - lo);
    for (let y = 0; y < word.h * scale; y++) {
      const sy = Math.min(word.h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(word.h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < word.w * scale; x++) {
        const sx = Math.min(word.w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(word.w - 1, x0 + 1), fx = sx - x0;
        const v = g[y0 * word.w + x0] * (1 - fx) * (1 - fy) + g[y0 * word.w + x1] * fx * (1 - fy) + g[y1 * word.w + x0] * (1 - fx) * fy + g[y1 * word.w + x1] * fx * fy;
        {
          // smoothstep tone curve: ink solid, paper clean (blurred text otherwise stays mushy)
          const u = Math.max(0, Math.min(1, (v - lo) / span));
          gray[(pad + y) * W + pad + x] = Math.round(255 * u * u * (3 - 2 * u));
        }
      }
    }
    return encodeGrayPng(W, H, gray);
  }
  for (let y = 0; y < word.h; y++) for (let x = 0; x < word.w; x++) {
    if (!word.ink[y * word.w + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) gray[(pad + y * scale + dy) * W + pad + x * scale + dx] = 0;
  }
  return encodeGrayPng(W, H, gray);
}

// ---------------------------------------------------------------------------------------------------------------
// tesseract.js (lazy, cached)

export interface ChordOcrConfig {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  /** false when the page CSP/bundler cannot create blob workers (browser only) */
  workerBlobURL?: boolean;
  cachePath?: string;
}

interface OcrWorker {
  recognize(img: Uint8Array): Promise<{ data: { text: string; confidence: number } }>;
  setParameters(p: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

let config: ChordOcrConfig = {};
let workerPromise: Promise<OcrWorker> | null = null;
let ocrUnavailable = false;

/** Override asset locations (e.g. serve `eng.traineddata.gz` and the wasm core from /public for offline use). */
export function configureChordOcr(c: ChordOcrConfig) {
  config = { ...config, ...c };
}

// In the browser the assets are served from /public/ocr (not precached by the service worker; see vite.config.ts).
// Skipped in Node (tests, bench), where tesseract.js uses its own defaults / cache.
if (typeof document !== 'undefined' || typeof (globalThis as { importScripts?: unknown }).importScripts === 'function') {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const dir = `${base.endsWith('/') ? base : `${base}/`}ocr`;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  configureChordOcr({ workerPath: `${origin}${dir}/worker.min.js`, corePath: `${origin}${dir}/core`, langPath: `${origin}${dir}/lang` });
}

export const CHORD_WHITELIST = 'ABCDEFGabdijmnsu#°ø+-/0123456789()';

const WORKER_TIMEOUT_MS = 25000;
const RECOGNIZE_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** True once chord OCR failed or timed out in this run; the remaining OCR calls are skipped. */
export function chordOcrUnavailable(): boolean {
  return ocrUnavailable;
}

/** Clear the sticky "OCR unavailable" flag (call at the start of each recognition run). */
export function resetChordOcrState() {
  ocrUnavailable = false;
}

function markUnavailable(): never {
  ocrUnavailable = true;
  void disposeChordOcr();
  throw new Error('chord OCR unavailable');
}

function getWorker(): Promise<OcrWorker> {
  if (ocrUnavailable) return Promise.reject(new Error('chord OCR unavailable'));
  if (!workerPromise) {
    const p = withTimeout((async () => {
      const T = await import('tesseract.js');
      const createWorker = (T as { createWorker?: unknown }).createWorker ?? (T as { default: { createWorker: unknown } }).default.createWorker;
      const w = (await (createWorker as (l: string, o: number, opts: Record<string, unknown>) => Promise<OcrWorker>)('eng', 1, { ...config })) as OcrWorker;
      await w.setParameters({
        tessedit_char_whitelist: CHORD_WHITELIST,
        tessedit_pageseg_mode: '7', // single text line
        preserve_interword_spaces: '0',
      });
      return w;
    })(), WORKER_TIMEOUT_MS, 'creating the OCR worker');
    workerPromise = p;
    p.catch(() => {
      if (workerPromise === p) workerPromise = null;
      ocrUnavailable = true;
    });
  }
  return workerPromise;
}

export async function disposeChordOcr() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { await (await p).terminate(); } catch { /* ignore */ }
}

/** `recognize` with a per-call timeout; a failure or timeout marks OCR unavailable for the rest of the run. */
async function recognize(w: OcrWorker, img: Uint8Array): Promise<{ text: string; confidence: number }> {
  try {
    const r = await withTimeout(w.recognize(img), RECOGNIZE_TIMEOUT_MS, 'OCR recognize');
    const c = r.data.confidence;
    return { text: r.data.text.trim(), confidence: (Number.isFinite(c) ? c : 0) / 100 };
  } catch {
    return markUnavailable();
  }
}

/** OCR with the chord whitelist; falls back to an unrestricted pass for words that do not parse (tempo text etc.). */
export async function ocrWords(words: TextWord[], staffSpace: number): Promise<{ text: string; confidence: number }[]> {
  const w = await getWorker();
  const out: { text: string; confidence: number }[] = [];
  for (const word of words) {
    const png = wordToPng(word, staffSpace);
    out.push(await recognize(w, png));
  }
  return out;
}

/** Second opinion for doubtful words: single-word segmentation at a different scale. Returns the candidate texts. */
async function ocrRetry(word: TextWord, staffSpace: number): Promise<{ text: string; confidence: number }[]> {
  const w = await getWorker();
  const out: { text: string; confidence: number }[] = [];
  try {
    for (const [psm, d] of [['8', 1], ['7', -1], ['8', 0]] as const) {
      await w.setParameters({ tessedit_pageseg_mode: psm });
      out.push(await recognize(w, wordToPng(word, staffSpace, d)));
    }
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: '7' });
  }
  return out;
}

async function ocrFree(words: TextWord[], staffSpace: number): Promise<string[]> {
  const w = await getWorker();
  await w.setParameters({ tessedit_char_whitelist: '' });
  const out: string[] = [];
  try {
    for (const word of words) out.push((await recognize(w, wordToPng(word, staffSpace))).text);
  } finally {
    await w.setParameters({ tessedit_char_whitelist: CHORD_WHITELIST });
  }
  return out;
}

/** Full result: chords plus excluded rehearsal/tempo text and the raw OCR strings. */
export async function readChordText(b: Binary, staff: Staff, opts: FindOptions & { minConfidence?: number } = {}): Promise<ChordTextResult> {
  const result: ChordTextResult = { chords: [], excluded: [], raw: [] };
  const words = findTextWords(b, staff, opts);
  if (words.length === 0) return result;
  const minConf = opts.minConfidence ?? 0.5;
  const toOcr: TextWord[] = [];
  for (const word of words) {
    const x = (word.x0 + word.x1) / 2;
    if (word.boxed) result.excluded.push({ x, text: '', kind: 'rehearsal' });
    else toOcr.push(word);
  }
  if (toOcr.length === 0) return result;
  const ocr = await ocrWords(toOcr, staff.staffSpace);
  const unparsed: number[] = [];
  for (let i = 0; i < toOcr.length; i++) {
    const word = toOcr[i];
    const x = (word.x0 + word.x1) / 2;
    let { text, confidence } = ocr[i];
    {
      const first = parseChordText(text);
      if (!first || first.confidence * confidence < 0.75) {
        let bestScore = first ? first.confidence * (0.5 + 0.5 * confidence) : 0;
        for (const cand of await ocrRetry(word, staff.staffSpace)) {
          const p = parseChordText(cand.text);
          if (!p) continue;
          // a longer reading of the same prefix wins ties ("Cm7" over "Cm"): dropped characters are the common failure
          const score = p.confidence * (0.5 + 0.5 * cand.confidence) + (cand.text.length > text.length ? 0.03 : 0);
          if (score > bestScore) { bestScore = score; text = cand.text; confidence = cand.confidence; }
        }
      }
    }
    result.raw.push({ x, text, confidence });
    // A bare letter A-G that is clearly bigger than the chord text around it, or that is followed closely by another
    // word, is a rehearsal mark (set in a larger face, often unboxed), never a chord.
    if (/^[A-G]$/.test(text.replace(/[^A-Za-z]/g, '')) && text.replace(/[^A-Za-z]/g, '').length === 1) {
      const others = toOcr.filter((o) => o !== word);
      const hs = others.map((o) => o.h).sort((a, c) => a - c);
      const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
      const bigger = medH > 0 && word.h >= 1.25 * medH;
      const crowded = others.some((o) => o.x0 >= word.x1 && o.x0 - word.x1 <= 3 * staff.staffSpace && Math.abs((o.y0 + o.y1) / 2 - (word.y0 + word.y1) / 2) <= 1.5 * staff.staffSpace);
      if (bigger || crowded) {
        result.excluded.push({ x, text, kind: 'rehearsal' });
        continue;
      }
    }
    const p = parseChordText(text);
    if (p && p.confidence * Math.max(0.5, confidence) >= minConf * 0.6 && classifyNonChord(text) !== 'rehearsal') {
      result.chords.push({ x, text: p.text, chord: p.chord, confidence: Math.min(1, p.confidence * (0.5 + 0.5 * confidence)) });
    } else {
      const parts = splitChordWord(text);
      if (parts) {
        const len = text.replace(/[()\s]/g, '').length || 1;
        for (const part of parts) {
          const pp = parseChordText(part.text)!;
          const px = word.x0 + ((part.start + part.end) / 2 / len) * (word.x1 - word.x0);
          result.chords.push({ x: px, text: pp.text, chord: pp.chord, confidence: pp.confidence * 0.6 });
        }
      } else unparsed.push(i);
    }
  }
  if (unparsed.length) {
    const free = await ocrFree(unparsed.map((i) => toOcr[i]), staff.staffSpace);
    unparsed.forEach((i, k) => {
      const x = (toOcr[i].x0 + toOcr[i].x1) / 2;
      result.excluded.push({ x, text: free[k], kind: classifyNonChord(free[k] || ocr[i].text) });
    });
  }
  result.chords.sort((a, c) => a.x - c.x);
  return result;
}

/** Chord labels above `staff`, left to right. Returns [] (never throws) when OCR is unavailable. */
export async function detectChordLabels(b: Binary, staff: Staff, opts: FindOptions & { minConfidence?: number } = {}): Promise<ChordLabel[]> {
  if (ocrUnavailable) return [];
  try {
    return (await readChordText(b, staff, opts)).chords;
  } catch {
    return [];
  }
}

/** Assign `measureIndex` by barline x ranges: barlines are the interior barline xs of the staff (sorted). */
export function assignMeasures(labels: ChordLabel[], barlines: number[], firstMeasure = 0): ChordLabel[] {
  const bars = [...barlines].sort((a, c) => a - c);
  return labels.map((l) => {
    let k = 0;
    while (k < bars.length && l.x > bars[k]) k++;
    return { ...l, measureIndex: firstMeasure + k };
  });
}
