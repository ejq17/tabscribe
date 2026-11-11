/**
 * Tempo-mark probe: npx tsx scripts/omr-bench/tempo-probe.ts [--scale 2.5] [file.pdf|dir ...]
 * Default inputs: the two local charts and the four corpus lead sheets. Prints, per system, the OCR'd tempo marks
 * (beat unit, bpm), then the resulting score.tempos and the tempo warnings, and compares with <sound tempo=>/<metronome>
 * in score.musicxml where one exists.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePage, assembleScore, readPageChords } from '../../src/omr/assemble';
import { configureChordOcr, disposeChordOcr, resetChordOcrState } from '../../src/omr/chordtext';
import type { RawImage } from '../../src/omr/types';

const args = process.argv.slice(2);
const scale = Number(args.includes('--scale') ? args[args.indexOf('--scale') + 1] : 2.5);
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scale');
const defaults = [
  'tests/fixtures/omr/real-local/funk-tank-guitar.pdf',
  'tests/fixtures/omr/real-local/a-child-is-born-guitar.pdf',
  ...['greensleeves', 'st-louis-blues', 'londonderry-air', 'after-youve-gone'].map((n) => `tests/fixtures/omr/corpus/${n}`),
];
configureChordOcr({ cachePath: process.env.TESS_CACHE ?? '/private/tmp/claude-501/-Users-ejquigley-Documents-Projects-Sheet-Music-to-Guitar-Tabs/5ecd0d2c-4e15-4b1e-94a8-3cd0301c1a16/scratchpad/tess-cache' });

async function renderPdf(file: string): Promise<RawImage[]> {
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

async function loadDir(dir: string): Promise<RawImage[]> {
  const files = readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
  const out: RawImage[] = [];
  for (const f of files) {
    const img = await loadImage(readFileSync(join(dir, f)));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, img.width, img.height);
    out.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
  }
  return out;
}

for (const input of inputs.length ? inputs : defaults) {
  console.log(`\n=== ${input}`);
  const pages = input.endsWith('.pdf') ? await renderPdf(input) : await loadDir(input);
  resetChordOcrState();
  const results = pages.map((img, i) => analyzePage(img, i));
  const t0 = Date.now();
  for (const r of results) await readPageChords(r);
  results.forEach((r, pi) => (r.tempoMarks ?? []).forEach((marks, si) => marks.forEach((m) => {
    console.log(`  page ${pi + 1} system ${si + 1}: ${m.kind} bpm=${m.bpm} conf=${m.confidence.toFixed(2)} unit=${m.unit ? `${m.unit.dotted ? 'dotted ' : ''}${m.unit.name}/${m.unit.source}` : '-'} text=${JSON.stringify(m.text)} -> ${m.description}`);
  })));
  const score = assembleScore(results);
  console.log(`  OCR ${Date.now() - t0} ms; score.tempos = ${JSON.stringify(score.tempos)}`);
  for (const w of score.meta.warnings ?? []) if (/^Tempo/.test(w)) console.log(`  warning: ${w}`);
  if (!input.endsWith('.pdf') && existsSync(join(input, 'score.musicxml'))) {
    const xml = readFileSync(join(input, 'score.musicxml'), 'utf8');
    const sounds = [...xml.matchAll(/<sound[^>]*tempo="([\d.]+)"/g)].map((m) => m[1]);
    const metro = [...xml.matchAll(/<beat-unit>(\w+)<\/beat-unit>[\s\S]{0,40}?<per-minute>([\d.]+)/g)].map((m) => `${m[1]}=${m[2]}`);
    console.log(`  musicxml: sound tempo=${sounds.join(',') || '(none)'} metronome=${metro.join(',') || '(none)'}`);
  }
  for (const r of results) { delete r.binary; delete r.grey; }
}
await disposeChordOcr();
