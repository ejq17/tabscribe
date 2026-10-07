/**
 * TabScribe OMR (optical music recognition).
 *
 * Public API
 *  - renderPdfPages(data, scale?)            PDF → canvases (pdf.js, worker bundled locally)
 *  - imageToCanvas(file)                     image file → canvas
 *  - recognizeScore(pages, opts?)            canvases → Score (pixel work runs in a Web Worker when available)
 *  - recognizeImageData(pages, opts?)        pure/synchronous version over `{width,height,data}` RGBA buffers
 *  - detectStaves(binary), binarize(image)   building blocks (exported for tests)
 *
 * Score output conventions (documented for the UI):
 *  - `meta.source = 'omr'`
 *  - `meta.sourcePages`   one JPEG data URL (quality 0.8) per input page, in order
 *  - `meta.warnings`      human-readable problems (missing clef, pages without staves, measures that were rescaled …)
 *  - `meta.omrBoxes`      `Record<NoteId, OmrBox[]>`. For every note id, an array (currently one entry) of
 *                         `{ page, x, y, w, h }` in ORIGINAL page-pixel coordinates of the canvas passed to
 *                         `recognizeScore` (`page` is the 0-based index into `meta.sourcePages`). The box is the
 *                         notehead's bounding region; use it to highlight the source when a note is selected.
 *  - Piano grand staves (two staves joined by a brace/system barline) become ONE track: voice 0 = treble staff,
 *    voice 1 = bass staff, with aligned measure starts. Other multi-staff systems yield one track per staff row.
 *  - `note.confidence` is 0..1 (lowered for stemless/ambiguous heads and for measures whose durations had to be rescaled).
 */
import type { Score } from '../core';
import { recognizeImageData } from './assemble';
import type { RawImage, RecognizeOptions } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';

export { renderPdfPages } from './pdf';
export { imageToCanvas } from './image';
export { recognizeImageData, analyzePage, assembleScore } from './assemble';
export { binarize, preprocess } from './preprocess';
export { detectStaves, removeStaffLines } from './staves';
export type { OmrBox, PageResult, RawImage, Staff, StaffSymbols } from './types';

export interface OmrOptions {
  onProgress?: (p: { stage: string; fraction: number; page?: number }) => void;
  defaultClef?: 'treble' | 'bass';
}

function canvasToRaw(c: HTMLCanvasElement): RawImage {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is not available');
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { width: id.width, height: id.height, data: id.data };
}

function runInWorker(pages: RawImage[], opts: RecognizeOptions): Promise<Score> {
  return new Promise<Score>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.type === 'progress') opts.onProgress?.({ stage: m.stage, fraction: m.fraction, page: m.page });
      else if (m.type === 'done') {
        worker.terminate();
        resolve(m.score);
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'OMR worker failed'));
    };
    const req: WorkerRequest = {
      type: 'recognize',
      defaultClef: opts.defaultClef,
      pages: pages.map((p) => ({ width: p.width, height: p.height, buffer: p.data.buffer as ArrayBuffer })),
    };
    worker.postMessage(req, req.pages.map((p) => p.buffer));
  });
}

export async function recognizeScore(pages: HTMLCanvasElement[], opts: OmrOptions = {}): Promise<Score> {
  opts.onProgress?.({ stage: 'Preparing pages', fraction: 0 });
  const sourcePages = pages.map((c) => {
    try {
      return c.toDataURL('image/jpeg', 0.8);
    } catch {
      return '';
    }
  });
  const raws = pages.map(canvasToRaw);
  let score: Score;
  if (typeof Worker !== 'undefined') {
    try {
      // buffers are transferred, so the worker run needs its own copies if we must fall back
      const copies = raws.map((r) => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) }));
      score = await runInWorker(copies, opts);
    } catch {
      score = await runInline(raws, opts);
    }
  } else {
    score = await runInline(raws, opts);
  }
  score.meta.source = 'omr';
  score.meta.sourcePages = sourcePages;
  return score;
}

async function runInline(raws: RawImage[], opts: RecognizeOptions): Promise<Score> {
  // yield once so the UI can paint the progress state before the heavy synchronous work
  await new Promise((r) => setTimeout(r, 0));
  return recognizeImageData(raws, opts);
}
