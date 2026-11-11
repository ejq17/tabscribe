/**
 * Guitar-chart benchmark over the git-ignored real-local PDFs (missing files are skipped). Runs each PDF through the SAME path
 * the app uses: PDF text layer when the page has one, tesseract chord OCR otherwise, then prints a metrics table and scored
 * accuracy where ground truth exists:
 *   - flight-of-the-foo-birds-guitar.pdf   text-layer truth (printed bar number at the start of each bar, chord x in that bar)
 *   - harlem-nocturne-guitar.pdf           note pitch / onset F1 against harlem-nocturne-guitar.mid
 *   - a-child-is-born-guitar*.pdf, funk-tank-guitar.pdf   hand-read truth of score-a-child-is-born.ts / score-funk-tank.ts
 *
 * Usage: npx tsx scripts/omr-bench/guitar-corpus.ts --out DIR [--only substring] [--no-text] [--json FILE] [--scale 2.5]
 *   --no-text  ignore the text layer (pure image + OCR path), to compare the two
 * The heavy real-local vitest files (tests/omr5-foo-birds, tests/omr6-real-scans) are opt-in: OMR_REAL=1 npx vitest run <file>.
 * Needs Node 22 and tsx (see README of this folder / the project memory); tesseract.js runs in-process.
 */
import { createCanvas } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { register } from 'node:module';
import { recognizeImageDataWithChords } from '../../src/omr/assemble';
import { configureChordOcr } from '../../src/omr/chordtext';
import type { RawImage } from '../../src/omr/types';
import { allNotes, matchNotes, prf } from './metrics';
import { chordTruth, compareChords } from './foo-truth';
import { loadTruth, scoreAgainstTruth, formatTruthScore, sumTruthScores, chordEvidence, chordEvidenceByStaff, A_CHILD_PAGE1_TRUTH, tallyEvidence, type ChordEvidence } from './truth-score';

// '@tonejs/midi' only links under tsx through this resolve hook (see corpus-bench.ts)
register('./_midi-hook.mjs', import.meta.url);
const { importMidi } = await import('../../src/importers/midi');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dir = join(root, 'tests/fixtures/omr/real-local');
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outDir = opt('--out', join(root, '.omr-bench-out'));
const only = opt('--only', '');
const useText = !args.includes('--no-text');
const scale = Number(opt('--scale', '2.5'));
const jsonOut = opt('--json', '');
const chordDump = args.includes('--chord-dump'); // list every OCR chord label with confidence / repair / correctness
const evidenceAll: { file: string; rows: ChordEvidence[] }[] = [];
const goodMode = args.includes('--good'); // clean-font reference: a-child-is-born-guitar.pdf, OCR only, page-1 chord truth (run corpus-bench.ts --chords for the clean-corpus pieces)
const scansOnly = args.includes('--scans'); // only the PDFs that have a hand-read <name>.truth.json
mkdirSync(outDir, { recursive: true });
// keep tesseract's eng.traineddata cache out of the repo root (TESS_CACHE=dir to share one between runs)
configureChordOcr({ cachePath: process.env.TESS_CACHE ?? join(outDir, 'tess-cache') });

const FILES = [
  'flight-of-the-foo-birds-guitar.pdf',
  'flight-of-the-foo-birds-guitar-band.pdf',
  'flight-of-the-foo-birds-guitar-chords.pdf',
  'a-child-is-born-guitar.pdf',
  'a-child-is-born-guitar-band.pdf',
  'a-child-is-born-guitar-chords.pdf',
  'harlem-nocturne-guitar.pdf',
  'jazz-warmups-guitar.pdf',
  'early-morning-guitar.pdf',
  'funk-tank-guitar.pdf',
];

interface Item { str: string; x: number; y: number; w: number; h: number; font?: string }

async function load(file: string): Promise<{ pages: RawImage[]; items: Item[][] }> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), disableWorker: true, useSystemFonts: true, verbosity: 0 } as any).promise;
  const pages: RawImage[] = [];
  const items: Item[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    let vp = page.getViewport({ scale });
    const longest = Math.max(vp.width, vp.height);
    if (longest > 4000) vp = page.getViewport({ scale: (scale * 4000) / longest });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any } as any).promise;
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
    const its: Item[] = [];
    try {
      const tc = await page.getTextContent();
      for (const it of tc.items as any[]) {
        if (!('str' in it) || !it.str.length) continue;
        const m = (pdfjs as any).Util.transform(vp.transform, it.transform);
        its.push({ str: it.str, x: m[4], y: m[5], w: it.width * vp.scale, h: it.height * vp.scale, font: it.fontName });
      }
    } catch { /* no text */ }
    items.push(its);
    page.cleanup();
  }
  return { pages, items };
}

interface Row {
  file: string;
  textPages: string;
  measures: number;
  notes: number;
  chords: number;
  chordList: string[];
  slash: number;
  multiRests: string[];
  timeSigs: string[];
  key: string;
  tempo: string;
  warnings: string[];
  accuracy: string[];
  seconds: number;
}

const spanList = (score: any): string[] => {
  const out: string[] = [];
  for (const sys of score.meta.omrSystems ?? []) {
    const cells = sys.cells as { measure: number }[];
    for (let k = 0; k < cells.length; k++) {
      const next = k + 1 < cells.length ? cells[k + 1].measure : sys.firstMeasure + sys.measureCount;
      if (next - cells[k].measure > 1) out.push(`${cells[k].measure + 1}+${next - cells[k].measure}`);
    }
  }
  return out;
};

/** Foo Birds digital: truth straight from the text layer (see foo-truth.ts). */
function fooTruth(items: Item[][], score: any): string[] {
  const r = compareChords(chordTruth(items), score);
  const out = [`chords exact (symbol+bar+beat) ${r.exact}/${r.total}; symbol+bar ${r.symOk}/${r.total}; bar has a chord ${r.barOk}/${r.total}; extra reported ${r.extra}`];
  if (r.miss.length) out.push(`misses: ${r.miss.slice(0, 12).join('; ')}${r.miss.length > 12 ? ` (+${r.miss.length - 12})` : ''}`);
  return out;
}

function harlemTruth(score: any): string[] {
  const mid = importMidi((() => { const b = readFileSync(join(dir, 'harlem-nocturne-guitar.mid')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; })());
  const out: string[] = [];
  const ppq = score.ppq;
  // a tied continuation is the same sounding note as the one before it (a MIDI file holds it as one note)
  const rec = allNotes(score).filter((n) => !n.tiedFromPrevious).map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration })).sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  let best: { name: string; f1: number; line: string } | undefined;
  for (const tr of mid.tracks) {
    if (!tr.notes.length) continue;
    const t = tr.notes.map((n) => ({ pitch: n.pitch, start: Math.round((n.start * ppq) / mid.ppq), duration: Math.round((n.duration * ppq) / mid.ppq) }));
    const tol = ppq / 8;
    // the part may be written an octave above the MIDI (guitar sounds an octave below): try 0 / +12 / -12 and keep the best
    let pick: { oct: number; off: number; exact: ReturnType<typeof prf>; pcOnly: ReturnType<typeof prf> } | undefined;
    for (const oct of [0, 12, -12]) {
      const r0 = rec.map((r) => ({ ...r, pitch: r.pitch + oct }));
      // global alignment: a small shift only (the MIDI covers the first chorus; a big shift would match a later repeat of the tune)
      let off = 0;
      let bestM = -1;
      for (let o = -4 * ppq; o <= 4 * ppq; o += ppq / 2) {
        const m = matchNotes(t, r0.map((r) => ({ ...r, start: r.start + o })), tol);
        if (m > bestM) { bestM = m; off = o; }
      }
      const shifted = r0.map((r) => ({ ...r, start: r.start + off }));
      const exact = prf(matchNotes(t, shifted, tol), t.length, shifted.length);
      if (!pick || exact.f1 > pick.exact.f1) pick = { oct, off, exact, pcOnly: prf(matchNotes(t, shifted, tol, undefined, true), t.length, shifted.length) };
    }
    const { oct, off, exact, pcOnly } = pick!;
    const line = `track "${tr.name}" (${t.length} notes; recognized pitch ${oct >= 0 ? '+' : ''}${oct}, offset ${off} ticks): pitch+onset F1 ${exact.f1.toFixed(2)} (P ${exact.precision.toFixed(2)} R ${exact.recall.toFixed(2)}, matched ${exact.matched}), pitch-class F1 ${pcOnly.f1.toFixed(2)}`;
    // order-preserving pitch-sequence match (the MIDI may omit whole sections the PDF prints, e.g. slash-chord choruses)
    const ts = [...t].sort((a, b) => a.start - b.start || b.pitch - a.pitch).map((n) => n.pitch);
    const rs = rec.map((n) => n.pitch + oct);
    let prev = new Array(rs.length + 1).fill(0);
    for (let i = 1; i <= ts.length; i++) {
      const cur = new Array(rs.length + 1).fill(0);
      for (let j = 1; j <= rs.length; j++) cur[j] = ts[i - 1] === rs[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    const lcs = prev[rs.length];
    const line2 = `${line}; pitch-sequence LCS ${lcs}/${ts.length} MIDI notes (${((100 * lcs) / ts.length).toFixed(0)}%), recognized-only notes ${rs.length - lcs}`;
    if (!best || lcs / ts.length > best.f1) best = { name: tr.name, f1: lcs / ts.length, line: line2 };
  }
  out.push(best ? `best MIDI track: ${best.line}` : 'MIDI has no notes');
  out.push(`recognized notes ${rec.length}`);
  return out;
}

function runScoreScript(script: string, name: string, score: any): string[] {
  const ppq = score.ppq;
  const total = (score.meta.omrMeasures as number) ?? 0;
  const tsAt = (t: number) => [...score.timeSignatures].filter((x: any) => x.tick <= t).pop() ?? { numerator: 4, denominator: 4 };
  const bounds: { n: number; start: number; len: number }[] = [];
  let c = 0;
  for (let n = 1; n <= total; n++) { const ts = tsAt(c); const len = (ppq * 4 * ts.numerator) / ts.denominator; bounds.push({ n, start: c, len }); c += len; }
  const f = join(outDir, `${name}.score.json`);
  writeFileSync(f, JSON.stringify({ score: { ...score, meta: { ...score.meta, omrBoxes: undefined } }, bounds }));
  try {
    const txt = execFileSync('npx', ['tsx', join(here, script), f], { encoding: 'utf8', cwd: root, timeout: 120000 });
    return txt.split('\n').filter((l) => /^(Pitch|Expected|Unmatched|m162)/.test(l));
  } catch (e) {
    return [`score script failed: ${(e as Error).message.split('\n')[0]}`];
  }
}

const rows: Row[] = [];
const truthScores: ReturnType<typeof scoreAgainstTruth>[] = [];
for (const f of FILES) {
  const path = join(dir, f);
  if (!existsSync(path) || (only && !f.includes(only))) continue;
  const truth = loadTruth(path);
  if (scansOnly && !truth) continue;
  if (goodMode && f !== 'a-child-is-born-guitar.pdf') continue;
  const textHere = useText && !goodMode;
  const t0 = Date.now();
  const { pages, items } = await load(path);
  const score: any = await recognizeImageDataWithChords(pages, { instrument: 'guitar', ...(textHere ? { textItems: items as any } : {}) } as any);
  const secs = (Date.now() - t0) / 1000;
  const chords = (score.meta.omrChords ?? []) as { measure: number; text: string }[];
  const name = basename(f, '.pdf');
  const accuracy: string[] = [];
  if (f === 'flight-of-the-foo-birds-guitar.pdf') accuracy.push(...fooTruth(items, score));
  if (f === 'harlem-nocturne-guitar.pdf' && existsSync(join(dir, 'harlem-nocturne-guitar.mid'))) {
    try { accuracy.push(...harlemTruth(score)); } catch (e) { accuracy.push(`harlem truth failed: ${(e as Error).message}`); }
  }
  if (f.startsWith('a-child-is-born') && !f.endsWith('chords.pdf')) accuracy.push(...runScoreScript('score-a-child-is-born.ts', name, score));
  if (f === 'funk-tank-guitar.pdf') accuracy.push(...runScoreScript('score-funk-tank.ts', name, score));
  let truthScore: ReturnType<typeof scoreAgainstTruth> | undefined;
  if (truth) { truthScore = scoreAgainstTruth(score, truth, f); truthScores.push(truthScore); accuracy.push(...formatTruthScore(truthScore, truth)); }
  const goodFont = f === 'a-child-is-born-guitar.pdf' && !textHere; // clean-font reference: page 1 of the digital chart read by OCR only
  if (truth || goodFont) {
    const rows = truth ? chordEvidence(score, truth) : chordEvidenceByStaff(score, A_CHILD_PAGE1_TRUTH);
    evidenceAll.push({ file: f, rows });
    if (chordDump) for (const r of rows) console.log(`  CH ${f.replace('-guitar.pdf', '')} p${r.page} bar ${r.bar} ${r.text} ocr=${r.ocrConf!.toFixed(2)} conf=${r.confidence.toFixed(2)} ${r.repaired ? 'REPAIRED' : 'clean'} ${r.ok ? 'OK' : 'WRONG'} ${r.kept ? 'kept' : 'SUPPRESSED'}`);
  }
  const warn = (score.meta.warnings ?? []) as string[];
  const tempo = (score.tempos ?? []).map((t: any) => `${t.bpm}@${t.tick}`).join(',');
  rows.push({
    file: f,
    textPages: [...new Set(((score.meta.omrSystems ?? []) as any[]).filter((s) => s.textLayer).map((s) => s.page + 1))].join(',') || '-',
    measures: score.meta.omrMeasures ?? 0,
    notes: allNotes(score).length,
    chords: chords.length,
    chordList: chords.map((c) => `${c.measure + 1}:${c.text}`),
    slash: (score.meta.omrSlashMeasures ?? []).length,
    multiRests: spanList(score),
    timeSigs: score.timeSignatures.map((t: any) => `${t.numerator}/${t.denominator}@${Math.round(t.tick / score.ppq)}`),
    key: score.keySignatures.map((k: any) => `${k.fifths}@${Math.round(k.tick / score.ppq)}`).join(','),
    tempo,
    warnings: warn,
    accuracy,
    seconds: secs,
  });
  const r = rows[rows.length - 1];
  console.log(`\n### ${f}  (${secs.toFixed(0)} s, text-layer pages: ${r.textPages})`);
  console.log(`measures ${r.measures} | notes ${r.notes} | chords ${r.chords} | slash bars ${r.slash} | multi-rests ${r.multiRests.length} [${r.multiRests.join(' ')}]`);
  console.log(`time sigs ${r.timeSigs.join(' ')} | key ${r.key} | tempo ${r.tempo || '-'}`);
  console.log(`chords: ${r.chordList.slice(0, 16).join(' ')}${r.chordList.length > 16 ? ' ...' : ''}`);
  for (const w of warn) console.log(`  warning: ${w}`);
  for (const a of accuracy) console.log(`  accuracy: ${a}`);
}

if (truthScores.length) {
  console.log('\n=== TRUTH SCORES (hand-read <name>.truth.json; one line per scan) ===');
  for (const t of truthScores) console.log(t.line);
  console.log(sumTruthScores(truthScores));
}
if (evidenceAll.length) {
  console.log('\n=== OCR CHORDS vs truth (inside each truth chordRange): kept / correct kept / wrong kept / correct lost / wrong removed ===');
  const sum = { kept: 0, keptOk: 0, keptWrong: 0, lostOk: 0, removedWrong: 0, all: 0, allOk: 0 };
  for (const e of evidenceAll) {
    const t = tallyEvidence(e.rows);
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k];
    console.log(`${e.file.replace('-guitar.pdf', '').padEnd(28)} read ${t.all} (${t.allOk} correct) | kept ${t.kept}: ${t.keptOk} correct, ${t.keptWrong} wrong | correct lost ${t.lostOk} | wrong removed ${t.removedWrong}`);
  }
  console.log(`${'TOTAL'.padEnd(28)} read ${sum.all} (${sum.allOk} correct) | kept ${sum.kept}: ${sum.keptOk} correct, ${sum.keptWrong} wrong | correct lost ${sum.lostOk} | wrong removed ${sum.removedWrong}`);
}
console.log('\n| file | text pages | measures | notes | chords | slash | multi-rests | time sigs | key | tempo | warnings |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.file} | ${r.textPages} | ${r.measures} | ${r.notes} | ${r.chords} | ${r.slash} | ${r.multiRests.length} | ${r.timeSigs.join(' ')} | ${r.key} | ${r.tempo || '-'} | ${r.warnings.length} |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
