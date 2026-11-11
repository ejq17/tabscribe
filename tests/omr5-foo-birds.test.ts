// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { recognizeImageDataWithChords } from '../src/omr/assemble';
import type { RawImage } from '../src/omr/types';
import { chordTruth, compareChords } from '../scripts/omr-bench/foo-truth';

// The copyrighted chart is git-ignored (tests/fixtures/omr/real-local); the test skips when it is absent.
const PDF = join(__dirname, 'fixtures/omr/real-local/flight-of-the-foo-birds-guitar.pdf');
// OPT-IN (renders 3 pages + text layer; heavy under a parallel run): OMR_REAL=1 npx vitest run tests/omr5-foo-birds.test.ts
const present = !!process.env.OMR_REAL && existsSync(PDF);

describe.skipIf(!present)('real-local: Flight of the Foo Birds (digital guitar chart, text layer)', () => {
  it('reads 118 bars, every printed chord in the right bar and beat, key, tempo, slash bars and multi-rests', async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF)), disableWorker: true, useSystemFonts: true, verbosity: 0 } as never).promise;
    const pages: RawImage[] = [];
    const items: { str: string; x: number; y: number; w: number; h: number; font?: string }[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2.5 });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never } as never).promise;
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      pages.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
      const tc = await page.getTextContent();
      items.push(
        (tc.items as { str?: string; transform: number[]; width: number; height: number; fontName?: string }[])
          .filter((it) => it.str)
          .map((it) => {
            const m = pdfjs.Util.transform(vp.transform, it.transform);
            return { str: it.str!, x: m[4], y: m[5], w: it.width * vp.scale, h: it.height * vp.scale, font: it.fontName };
          }),
      );
    }
    const score = await recognizeImageDataWithChords(pages, { instrument: 'guitar', textItems: items });

    expect(score.meta.omrMeasures).toBe(118);
    const truth = chordTruth(items);
    expect(truth.length).toBe(107);
    const r = compareChords(truth, score);
    expect(r.exact).toBe(truth.length);
    expect(r.extra).toBe(0);
    expect(score.keySignatures[0].fifths).toBe(-3);
    expect(score.tempos[0].bpm).toBe(156);
    // one meter for the whole chart: no spurious 3/4 or 2/4 changes
    expect(score.timeSignatures).toHaveLength(1);
    expect(score.meta.omrSlashMeasures!.length).toBeGreaterThanOrEqual(55);
    // multi-measure rests: first bar (1-based) + length, as printed above the H-bars
    const spans: string[] = [];
    for (const sys of score.meta.omrSystems ?? []) {
      sys.cells.forEach((cell, k) => {
        const next = k + 1 < sys.cells.length ? sys.cells[k + 1].measure : sys.firstMeasure + sys.measureCount;
        if (next - cell.measure > 1) spans.push(`${cell.measure + 1}+${next - cell.measure}`);
      });
    }
    expect(spans).toEqual(['38+3', '57+8', '78+3', '81+4', '87+2', '89+4', '95+2', '103+2', '105+4']);
    expect((score.meta.omrSystems ?? []).every((s) => s.textLayer)).toBe(true);
  }, 120_000);
});
