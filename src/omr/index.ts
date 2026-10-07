/**
 * TabScribe OMR (optical music recognition).
 *
 * Public API
 *  - renderPdfPages(data, scale?)            PDF → canvases (pdf.js, worker bundled locally)
 *  - imageToCanvas(file)                     image file → canvas
 *  - recognizeScore(pages, opts?)            canvases → Score (pixel work runs in a Web Worker when available)
 *  - recognizeImageData(pages, opts?)        pure/synchronous version over `{width,height,data}` RGBA buffers (no chords)
 *  - recognizeImageDataWithChords(pages, opts?)  async version that also reads chord symbols
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
 *  - SYSTEMS: any number of staves joined by a continuous system barline at the left (voice + piano = 3, choir = 4 ...)
 *    form ONE system; measures are counted once per system. The barlines of the staves are voted (a barline is kept when
 *    at least half of the staves have it; with two staves the union is used), so a barline missed by one staff does not
 *    shift its notes, and every track shares the same measure timeline. Measure numbering continues across systems and pages.
 *  - Tracks: the two staves of a piano grand staff (the lowest staff pair, or a 2-staff system, joined by a brace) become
 *    ONE track: voice 0 = treble staff, voice 1 = bass staff. Every other staff of a system is its own track (voice 0),
 *    named "Staff N" (N = position in the system), or "Melody" when the system has a single staff.
 *  - PITCH IS SOUNDING PITCH. A treble clef with a small "8" printed below it (tenor, guitar) is read an octave lower
 *    (detected from the page image, voted per part). Guitar music is usually printed WITHOUT the 8; pass
 *    `instrument: 'guitar'` (RecognizeOptions) to read treble clefs an octave lower, EXCEPT inside a piano grand staff or any system that contains a bass-clef staff (keyboard music is not transposed). Default 'concert' reads
 *    treble clefs as written (plus the printed 8). The UI exposes this as the "written for guitar" setting.
 *  - `meta.omrMeasures`   number of measures the assembler laid out (courtesy key/time signatures after the last
 *                         barline of a staff are NOT measures; they are carried to the start of the next system).
 *  - `meta.omrSlashMeasures` (only present when found) `{ index, tick, length }[]`: bars written in slash / chord-hit
 *                         notation (>= 2 slashes, no noteheads). `index` is the 0-based measure number, `tick` its
 *                         start, `length` its length in ticks. These bars contain no notes; a strum chart can render
 *                         them using the chord symbols of that span. Absent for scores without slash bars.
 *  - `meta.omrChords` (only present when found) `{ measure, tick, text, chord:{root,quality,bass?}, confidence }[]`: chord
 *                         symbols read by OCR above the FIRST staff of each system. `measure` is the 0-based measure index as
 *                         the assembler counts it, `tick` the absolute tick (nearest beat within the measure, so several chords
 *                         per bar are possible). A label over a multi-measure rest sits on its first measure. Chord OCR needs
 *                         nested-worker support (tesseract.js); without it the key is simply absent. The app prefers these over
 *                         chords inferred from notes. `recognizeScore` returns them; `recognizeImageData` (sync) does not
 *                         (use `recognizeImageDataWithChords`).
 *  - Time signatures: printed ones are used; when none is printed and several consecutive bars add up to another
 *    meter, that meter is inferred (and a warning is added). Durations are never stretched to odd values: bars that
 *    are too long are snapped to standard durations, short bars are left as read.
 *  - `note.confidence` is 0..1 (lowered for stemless/ambiguous heads and for measures whose durations had to be rescaled).
 */
import type { Score } from '../core';
import { recognizeImageDataWithChords } from './assemble';
import type { OmrInstrument, RawImage, RecognizeOptions } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';

export { renderPdfPages } from './pdf';
export { imageToCanvas } from './image';
export { recognizeImageData, recognizeImageDataWithChords, analyzePage, assembleScore, readPageChords } from './assemble';
export type { OmrChordEntry } from './assemble';
export { detectChordLabels, readChordText, configureChordOcr } from './chordtext';
export type { ChordLabel } from './chordtext';
export { binarize, preprocess } from './preprocess';
export { detectStaves, removeStaffLines } from './staves';
export type { OmrBox, PageResult, RawImage, Staff, StaffSymbols } from './types';

export interface OmrOptions {
  onProgress?: (p: { stage: string; fraction: number; page?: number }) => void;
  defaultClef?: 'treble' | 'bass';
  /** 'guitar': treble clefs sound an octave below written. Default 'concert'. */
  instrument?: OmrInstrument;
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
      instrument: opts.instrument,
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
  return recognizeImageDataWithChords(raws, opts);
}
