/**
 * Chord-text probe: npx tsx scripts/omr-bench/chordtext-probe.ts [file.pdf] [--scale 2.5] [--out DIR]
 * Renders the PDF, runs staff detection + chord text OCR on every staff, and scores page 1 against ground truth.
 */
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { preprocess } from '../../src/omr/preprocess';
import { detectStaves } from '../../src/omr/staves';
import { readChordText, findTextWords, wordToPng, disposeChordOcr, configureChordOcr } from '../../src/omr/chordtext';
import type { RawImage } from '../../src/omr/types';

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.pdf')) ?? 'tests/fixtures/omr/real-local/a-child-is-born-guitar.pdf';
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const scale = Number(opt('--scale', '2.5'));
const outDir = opt('--out', '/private/tmp/claude-501/-Users-ejquigley-Documents-Projects-Sheet-Music-to-Guitar-Tabs/5ecd0d2c-4e15-4b1e-94a8-3cd0301c1a16/scratchpad/bench-chordtext');
const dumpStrips = args.includes('--strips');
mkdirSync(outDir, { recursive: true });
// keep eng.traineddata out of the repo root (tesseract.js caches into cwd by default)
configureChordOcr({ cachePath: process.env.TESS_CACHE ?? outDir + '/tess-cache' });

// Ground truth, page 1, keyed by 1-based staff number
const TRUTH: Record<number, string[]> = {
  2: ['Bbmaj7'],
  3: ['Ebm6/F', 'Bbmaj7', 'Ebm6/F', 'Bbmaj7', 'Ebm6/F'],
  4: ['Bbmaj7', 'Ebm6/F', 'Bbmaj7', 'Ebm6/F', 'Am11', 'D7b9b5'],
  5: ['Gmadd2', 'D7b9', 'Gmadd2', 'D7b9', 'Gmadd2', 'Gm7', 'C9'],
  6: ['Cm9', 'F9', 'Bbmaj7', 'Ebm6/Bb', 'Bbmaj7', 'Ebm6/Bb'],
  7: ['Bbmaj7', 'D7#9#5', 'Ebmaj7', 'Ab9', 'Bb/F', 'Ebm6/Gb'],
  8: ['Gm7', 'C9', 'Cm7'],
};

async function render(): Promise<RawImage[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), disableWorker: true, useSystemFonts: true, verbosity: 0 } as any).promise;
  const out: RawImage[] = [];
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
    out.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
    page.cleanup();
  }
  return out;
}

const pages = await render();
let hit = 0, total = 0, falsePos = 0;
const misses: string[] = [];
const lines: string[] = [];
const log = (s: string) => { console.log(s); lines.push(s); };
for (let pi = 0; pi < pages.length; pi++) {
  const pre = preprocess(pages[pi]);
  const staves = detectStaves(pre.binary);
  log(`\n=== Page ${pi + 1}: ${staves.length} staves ===`);
  for (let si = 0; si < staves.length; si++) {
    const staff = staves[si];
    let limitTop: number | undefined;
    for (let j = 0; j < staves.length; j++) {
      const o = staves[j];
      if (j !== si && o.bottom <= staff.top && o.right >= staff.left && o.left <= staff.right) limitTop = Math.max(limitTop ?? -Infinity, o.bottom + 0.6 * o.staffSpace);
    }
    if (dumpStrips) findTextWords(pre.binary, staff, { limitTop }).forEach((w, k) => writeFileSync(`${outDir}/p${pi + 1}-s${si + 1}-w${k}.png`, wordToPng(w, staff.staffSpace)));
    const t0 = Date.now();
    const r = await readChordText(pre.binary, staff, { limitTop });
    const got = r.chords.map((c) => c.text);
    log(`staff ${si + 1} (${Date.now() - t0}ms): ` + r.chords.map((c) => `${c.text}@${Math.round(c.x)}(${c.confidence.toFixed(2)})`).join('  ') +
      (r.excluded.length ? `   | excluded: ${r.excluded.map((e) => `${e.kind}:${JSON.stringify(e.text)}@${Math.round(e.x)}`).join(' ')}` : ''));
    log(`   raw: ${r.raw.map((w) => JSON.stringify(w.text)).join(' ')}`);
    if (pi === 0 && TRUTH[si + 1]) {
      const truth = TRUTH[si + 1];
      total += truth.length;
      // positional exact-match when counts agree, otherwise multiset matching
      const pool = [...got];
      truth.forEach((t, k) => {
        const same = got.length === truth.length ? got[k] === t : pool.includes(t);
        if (same) { hit++; if (got.length !== truth.length) pool.splice(pool.indexOf(t), 1); }
        else misses.push(`staff ${si + 1} #${k + 1}: want ${t}, got ${got.length === truth.length ? got[k] : '(count mismatch) ' + got.join(' ')}`);
      });
      falsePos += Math.max(0, got.length - truth.length);
    } else if (pi === 0 && got.length) falsePos += got.length;
  }
}
log(`\nPage 1 exact-match: ${hit}/${total} (${((100 * hit) / total).toFixed(1)}%), extra labels on staves with no/less truth: ${falsePos}`);
misses.forEach((m) => log('  MISS ' + m));
writeFileSync(`${outDir}/${basename(file, '.pdf')}-chordtext.txt`, lines.join('\n'));
await disposeChordOcr();
