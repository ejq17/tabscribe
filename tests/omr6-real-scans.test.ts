// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { recognizeImageData } from '../src/omr/assemble';
import type { RawImage } from '../src/omr/types';
import { loadTruth, scoreAgainstTruth } from '../scripts/omr-bench/truth-score';

// The copyrighted scans and their hand-read <name>.truth.json live in the git-ignored tests/fixtures/omr/real-local; every test
// skips when its files are absent. Structure only (bars per system, multi-rests, key, meter): chords / tempo need OCR (network).
// OPT-IN: these render and recognise five full PDFs (~30 s of CPU, which starves the other tests in a parallel run), so they run only
// with OMR_REAL=1:  OMR_REAL=1 npx vitest run tests/omr6-real-scans.test.ts tests/omr5-foo-birds.test.ts
const OPT_IN = !!process.env.OMR_REAL;
const DIR = join(__dirname, 'fixtures/omr/real-local');
const SCANS = [
  'flight-of-the-foo-birds-guitar-band.pdf',
  'a-child-is-born-guitar-band.pdf',
  'jazz-warmups-guitar.pdf',
  'early-morning-guitar.pdf',
  'funk-tank-guitar.pdf',
];

async function render(path: string): Promise<RawImage[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableWorker: true, useSystemFonts: true, verbosity: 0 } as never).promise;
  const pages: RawImage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    let vp = page.getViewport({ scale: 2.5 });
    const longest = Math.max(vp.width, vp.height);
    if (longest > 4000) vp = page.getViewport({ scale: (2.5 * 4000) / longest });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never } as never).promise;
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
  }
  return pages;
}

describe('real-local: scanned guitar parts, structure against hand-read truth', () => {
  for (const f of SCANS) {
    const path = join(DIR, f);
    const present = OPT_IN && existsSync(path) && existsSync(join(DIR, f.replace('.pdf', '.truth.json')));
    it.skipIf(!present)(`${f}: bars per system, multi-rests, key and meter match the printed score`, async () => {
      const truth = loadTruth(path)!;
      const score = recognizeImageData(await render(path), { instrument: 'guitar' });
      const s = scoreAgainstTruth(score, truth, f).n;
      expect(s.barsRec).toBe(s.barsTruth);
      expect(s.sysExact).toBe(s.sysTotal);
      expect(s.mrStrict).toBe(s.mrTruth);
      expect(s.mrExtra).toBe(0);
      expect(s.keyOk).toBe(s.bars);
      expect(s.meterOk).toBe(s.bars);
    }, 120000);
  }
});
