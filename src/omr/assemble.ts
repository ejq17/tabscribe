import { createEmptyScore, newNoteId, type Note, type Score, type Track } from '../core';
import { preprocess, toOriginal } from './preprocess';
import { detectStaves, systemsOf } from './staves';
import { analyzeStaff } from './symbols';
import { pitchMeasure } from './pitch';
import { layoutMeasure, staffMeasures, type RhythmEvent } from './rhythm';
import type { OmrBox, PageResult, RawImage, RecognizeOptions, Staff, StaffSymbols } from './types';

/** Run preprocessing, staff detection and symbol analysis on one page image. Pure; no DOM. */
export function analyzePage(img: RawImage, index: number, opts: RecognizeOptions = {}): PageResult {
  const defaultClef = opts.defaultClef ?? 'treble';
  const warnings: string[] = [];
  const pre = preprocess(img);
  const staves = detectStaves(pre.binary);
  const systems = systemsOf(staves);
  const symbols: StaffSymbols[] = [];
  if (staves.length === 0) warnings.push(`Page ${index + 1}: no staves found.`);
  staves.forEach((staff, i) => {
    // clip the region at the midpoint to vertical neighbours
    let y0 = -Infinity;
    let y1 = Infinity;
    for (let j = 0; j < staves.length; j++) {
      if (j === i) continue;
      const o = staves[j];
      if (o.right < staff.left || o.left > staff.right) continue;
      if (o.bottom <= staff.top) y0 = Math.max(y0, (o.bottom + staff.top) / 2);
      else if (o.top >= staff.bottom) y1 = Math.min(y1, (staff.bottom + o.top) / 2);
    }
    const sym = analyzeStaff(pre.binary, staff, { defaultClef, y0, y1 });
    for (const w of sym.warnings) warnings.push(`Page ${index + 1}, staff ${i + 1}: ${w}`);
    symbols.push(sym);
    opts.onProgress?.({ stage: 'Reading notation', fraction: (i + 1) / staves.length, page: index });
  });
  return {
    index,
    width: pre.binary.width,
    height: pre.binary.height,
    transform: pre.transform,
    staves,
    systems,
    symbols,
    warnings,
  };
}

function boxOf(page: PageResult, x0: number, y0: number, x1: number, y1: number): OmrBox {
  const pts = [
    toOriginal(page.transform, x0, y0),
    toOriginal(page.transform, x1, y0),
    toOriginal(page.transform, x0, y1),
    toOriginal(page.transform, x1, y1),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { page: page.index, x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** Build a Score from analyzed pages. */
export function assembleScore(pages: PageResult[], ppq = 480): Score {
  const score = createEmptyScore({ source: 'omr' });
  score.ppq = ppq;
  const warnings: string[] = [];
  const boxes: Record<string, OmrBox[]> = {};
  for (const p of pages) warnings.push(...p.warnings);

  // Pass 1: per-system measure event lists
  interface SysInfo {
    page: PageResult;
    staffIds: number[];
    measures: Map<number, RhythmEvent[][]>;
    count: number;
  }
  const sysInfos: SysInfo[] = [];
  for (const page of pages) {
    for (const sys of page.systems) {
      const measures = new Map<number, RhythmEvent[][]>();
      let count = 0;
      for (const si of sys) {
        const staff = page.staves[si];
        const m = staffMeasures(page.symbols[si], page.symbols[si].stems, staff.staffSpace, ppq);
        measures.set(si, m);
        count = Math.max(count, m.length);
      }
      if (count > 0 || sys.length > 0) sysInfos.push({ page, staffIds: sys, measures, count });
    }
  }
  const totalMeasures = sysInfos.reduce((s, x) => s + x.count, 0);

  const tracks = new Map<string, Track>();
  const trackFor = (key: string, name: string): Track => {
    let t = tracks.get(key);
    if (!t) {
      t = { id: `omr-${key}`, name, program: 25, notes: [] };
      tracks.set(key, t);
    }
    return t;
  };

  let cursor = 0;
  let measureNo = 0;
  let curTs = { numerator: 4, denominator: 4 };
  const carryByStaffKey = new Map<string, Map<number, number>>();
  let lastKey = 0;
  let mismatchCount = 0;

  for (const si of sysInfos) {
    const syms = si.staffIds.map((i) => si.page.symbols[i]);
    // time + key signature from the system's first staff that reports one
    const ts = syms.find((s) => s.timeSig)?.timeSig;
    if (ts && (ts.numerator !== curTs.numerator || ts.denominator !== curTs.denominator)) {
      curTs = ts;
      if (cursor === 0) score.timeSignatures = [{ tick: 0, ...ts }];
      else score.timeSignatures.push({ tick: cursor, ...ts });
    } else if (ts && cursor === 0) score.timeSignatures = [{ tick: 0, ...ts }];
    const fifths = syms[0]?.keyFifths ?? 0;
    if (fifths !== lastKey || (cursor === 0 && score.keySignatures.length === 0)) {
      if (cursor === 0) score.keySignatures = [{ tick: 0, fifths, mode: 'major' }];
      else score.keySignatures.push({ tick: cursor, fifths, mode: 'major' });
      lastKey = fifths;
    }
    const nominal = (ppq * 4 * curTs.numerator) / curTs.denominator;
    const grand = si.staffIds.length > 1 && si.page.staves[si.staffIds[1]].lowerOfGrand;

    for (let m = 0; m < Math.max(1, si.count); m++) {
      const start = cursor;
      for (const stIdx of si.staffIds) {
        const staff: Staff = si.page.staves[stIdx];
        const sym = si.page.symbols[stIdx];
        const events = si.measures.get(stIdx)?.[m] ?? [];
        if (events.length === 0) continue;
        const isFirst = measureNo === 0;
        const isLast = measureNo === totalMeasures - 1;
        const layout = layoutMeasure(events, nominal, ppq, isFirst || isLast);
        if (layout.mismatch) mismatchCount++;
        const key = grand ? 'grand' : `part${staff.partIndex}`;
        const track = trackFor(key, grand ? 'Piano' : si.staffIds.length > 1 ? `Staff ${staff.partIndex + 1}` : 'Melody');
        const voice = grand ? staff.partIndex : 0;
        const ckey = `${key}:${voice}`;
        const heads = layout.placed.flatMap((p) => (p.event.kind === 'cluster' ? p.event.cluster.heads : []));
        const { pitched, carry } = pitchMeasure(heads, staff, sym.clef, sym.keyFifths, carryByStaffKey.get(ckey) ?? new Map());
        carryByStaffKey.set(ckey, carry);
        const byHead = new Map(pitched.map((p) => [p.head, p]));
        for (const pe of layout.placed) {
          if (pe.event.kind !== 'cluster') continue;
          const c = pe.event.cluster;
          c.heads.forEach((h, hi) => {
            const p = byHead.get(h);
            if (!p) return;
            const id = newNoteId();
            const dur = Math.max(1, Math.round(c.durations[hi] * pe.scale));
            const note: Note = {
              id,
              pitch: p.midi,
              start: start + pe.start,
              duration: dur,
              velocity: 90,
              voice,
              spelling: p.spelling,
              confidence: Math.max(0.05, Math.min(1, h.confidence * (layout.scaled ? 0.75 : 1) * (layout.mismatch && !layout.scaled ? 0.85 : 1))),
            };
            if (h.tiedFromPrevious) note.tiedFromPrevious = true;
            track.notes.push(note);
            boxes[id] = [boxOf(si.page, h.x0, h.y0, h.x1, h.y1)];
          });
        }
      }
      cursor += nominal;
      measureNo++;
    }
  }

  const trackList = [...tracks.values()];
  for (const t of trackList) t.notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  if (trackList.length > 0) trackList[0].isGuitarTarget = true;
  score.tracks = trackList;
  if (mismatchCount > 0) {
    warnings.push(`${mismatchCount} measure(s) did not add up to the time signature; durations were adjusted. Check rhythms.`);
  }
  if (trackList.every((t) => t.notes.length === 0)) warnings.push('No notes were recognized. Try a cleaner, higher-resolution scan.');
  score.meta.warnings = [...new Set(warnings)];
  score.meta.omrBoxes = boxes;
  return score;
}

/**
 * Pure end-to-end recognition over raw RGBA pages (no DOM, usable in a Worker or under node/jsdom tests).
 * Page images are NOT stored in `meta.sourcePages` here; `recognizeScore` in index.ts adds those from the canvases.
 */
export function recognizeImageData(pages: RawImage[], opts: RecognizeOptions = {}): Score {
  const results: PageResult[] = [];
  pages.forEach((img, i) => {
    opts.onProgress?.({ stage: 'Analyzing page', fraction: i / Math.max(1, pages.length), page: i });
    results.push(analyzePage(img, i, opts));
  });
  opts.onProgress?.({ stage: 'Assembling score', fraction: 0.97 });
  const score = assembleScore(results);
  opts.onProgress?.({ stage: 'Done', fraction: 1 });
  return score;
}

