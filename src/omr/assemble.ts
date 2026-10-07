import { createEmptyScore, newNoteId, type Note, type Score, type Track } from '../core';
import { preprocess, toOriginal } from './preprocess';
import { detectStaves, systemsOf } from './staves';
import { analyzeStaff } from './symbols';
import { pitchMeasure } from './pitch';
import { layoutMeasure, quantizeTicks, staffMeasures, type RhythmEvent } from './rhythm';
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
    let limitTop = -Infinity;
    let limitBottom = Infinity;
    for (let j = 0; j < staves.length; j++) {
      if (j === i) continue;
      const o = staves[j];
      if (o.right < staff.left || o.left > staff.right) continue;
      if (o.bottom <= staff.top) {
        y0 = Math.max(y0, (o.bottom + staff.top) / 2);
        limitTop = Math.max(limitTop, o.bottom + 0.6 * o.staffSpace);
      } else if (o.top >= staff.bottom) {
        y1 = Math.min(y1, (staff.bottom + o.top) / 2);
        limitBottom = Math.min(limitBottom, o.top - 0.6 * o.staffSpace);
      }
    }
    const sym = analyzeStaff(pre.binary, staff, { defaultClef, y0, y1, limitTop, limitBottom });
    for (const w of sym.warnings) warnings.push(`Page ${index + 1}, staff ${i + 1}: ${w}`);
    symbols.push(sym);
    opts.onProgress?.({ stage: 'Reading notation', fraction: (i + 1) / staves.length, page: index });
  });
  assignTuplets(staves, symbols);
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

/**
 * A triplet bracket found near one staff belongs to the staff whose notes it spans: the one with the smallest gap
 * between the bracket and the heads / stems under (or over) it. Brackets seen by two neighbouring staves are merged.
 */
function assignTuplets(staves: Staff[], symbols: StaffSymbols[]): void {
  const cands: { x0: number; x1: number; n: number; y0: number; y1: number }[] = [];
  for (const s of symbols) {
    for (const c of s.tupletCands ?? []) {
      if (!cands.some((o) => Math.abs(o.x0 - c.x0) < 3 && Math.abs(o.x1 - c.x1) < 3 && Math.abs(o.y0 - c.y0) < 3)) cands.push(c);
    }
  }
  for (const c of cands) {
    let best = -1;
    let bestGap = Infinity;
    symbols.forEach((s, j) => {
      const d = staves[j].staffSpace;
      let ymin = Infinity;
      let ymax = -Infinity;
      let count = 0;
      for (const h of s.heads) {
        if (h.cx < c.x0 - 0.3 * d || h.cx > c.x1 + 0.3 * d) continue;
        count++;
        ymin = Math.min(ymin, h.y0);
        ymax = Math.max(ymax, h.y1);
        if (h.stemId >= 0) {
          const st = s.stems[h.stemId];
          ymin = Math.min(ymin, st.top);
          ymax = Math.max(ymax, st.bottom);
        }
      }
      for (const r of s.rests) {
        const cx = (r.x0 + r.x1) / 2;
        if (cx < c.x0 - 0.3 * d || cx > c.x1 + 0.3 * d) continue;
        count++;
        ymin = Math.min(ymin, r.y0);
        ymax = Math.max(ymax, r.y1);
      }
      if (count === 0) return;
      const gap = c.y1 <= ymin ? ymin - c.y1 : c.y0 >= ymax ? c.y0 - ymax : 0;
      // the bracket hugs its notes: within about four staff spaces of the nearest head / stem
      if (gap <= 4.2 * d && gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    });
    if (best >= 0) (symbols[best].tuplets ??= []).push({ x0: c.x0, x1: c.x1, n: c.n });
  }
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

/** Most common value of a list (first wins ties). */
function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bc = -1;
  for (const v of values) {
    const c = counts.get(v)!;
    if (c > bc) {
      bc = c;
      best = v;
    }
  }
  return best;
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

  // Key signatures: vote per system, then only accept a change when two consecutive systems agree on it
  const sysKey = sysInfos.map((si) => modeOf(si.staffIds.map((i) => si.page.symbols[i].keyFifths)));
  const effKey: number[] = [];
  {
    let cur = sysKey[0] ?? 0;
    if (sysKey.length >= 3 && sysKey[0] !== sysKey[1] && sysKey[1] === sysKey[2]) cur = sysKey[1];
    sysKey.forEach((f, i) => {
      if (i > 0 && f !== cur && sysKey[i + 1] === f) cur = f;
      effKey.push(cur);
    });
  }

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
  let tsKnown = false;
  const carryByStaffKey = new Map<string, Map<number, number>>();
  const lastClef = new Map<number, 'treble' | 'bass'>();
  let lastKey = Number.NaN;
  let mismatchCount = 0;
  let clippedCount = 0;
  let slashMeasures = 0;
  let pendingTie = new Map<string, number>();
  const pageWarned = { clef: new Set<number>(), ts: new Set<number>() };

  for (let sIdx = 0; sIdx < sysInfos.length; sIdx++) {
    const si = sysInfos[sIdx];
    const syms = si.staffIds.map((i) => si.page.symbols[i]);
    // time signature: first staff of the system that reports one; later systems inherit silently
    const ts = syms.find((s) => s.timeSig)?.timeSig;
    if (ts) {
      if (!tsKnown || ts.numerator !== curTs.numerator || ts.denominator !== curTs.denominator) {
        if (cursor === 0) score.timeSignatures = [{ tick: 0, ...ts }];
        else score.timeSignatures.push({ tick: cursor, ...ts });
        curTs = ts;
      }
      tsKnown = true;
    } else if (!tsKnown && syms.some((s) => s.timeSigUnreadable) && !pageWarned.ts.has(si.page.index)) {
      pageWarned.ts.add(si.page.index);
      warnings.push(`Page ${si.page.index + 1}: a time signature could not be read; assumed 4/4.`);
    }
    const fifths = effKey[sIdx] ?? 0;
    if (fifths !== lastKey) {
      if (cursor === 0) score.keySignatures = [{ tick: 0, fifths, mode: 'major' }];
      else score.keySignatures.push({ tick: cursor, fifths, mode: 'major' });
      lastKey = fifths;
    }
    const nominal = (ppq * 4 * curTs.numerator) / curTs.denominator;
    const grand = si.staffIds.length > 1 && si.page.staves[si.staffIds[1]].lowerOfGrand;
    // clef per staff row: inherit the previous system's clef when none is printed
    const clefs = si.staffIds.map((stIdx) => {
      const sym = si.page.symbols[stIdx];
      const part = si.page.staves[stIdx].partIndex;
      if (sym.clefDetected) {
        lastClef.set(part, sym.clef);
        return sym.clef;
      }
      const prev = lastClef.get(part);
      if (prev && !si.page.staves[stIdx].lowerOfGrand) return prev;
      if (sym.clefMissing && !pageWarned.clef.has(si.page.index)) {
        pageWarned.clef.add(si.page.index);
        warnings.push(`Page ${si.page.index + 1}: no clef was found on at least one staff; assumed ${sym.clef}.`);
      }
      return sym.clef;
    });
    for (const sym of syms) {
      const mrs = sym.multiRests ?? [];
      mrs.forEach((mr) => {
        if (!mr.guessed) return;
        // bar number: first bar of this system + barlines before the rest + extra bars of earlier multi-measure rests
        const centre = (mr.x0 + mr.x1) / 2;
        const slot = sym.barlines.filter((b) => b < centre).length;
        let extra = 0;
        for (const o of mrs) if (o !== mr && (o.x0 + o.x1) / 2 < centre) extra += Math.max(0, o.count - 1);
        warnings.push(`Page ${si.page.index + 1}: the multi-measure rest at measure ${measureNo + slot + extra + 1} has no readable count; counted as 1 measure.`);
      });
    }
    const nextPending = new Map<string, number>();
    const firstDone = new Set<string>();

    for (let m = 0; m < Math.max(1, si.count); m++) {
      const start = cursor;
      si.staffIds.forEach((stIdx, sPos) => {
        const staff: Staff = si.page.staves[stIdx];
        const sym = si.page.symbols[stIdx];
        const events = si.measures.get(stIdx)?.[m] ?? [];
        if ((sym.slashes?.length ?? 0) >= 2 && events.length === 0 && staffHasSlashIn(sym, si.measures.get(stIdx), m)) slashMeasures++;
        if (events.length === 0) return;
        const isFirst = measureNo === 0;
        const isLast = measureNo === totalMeasures - 1;
        const layout = layoutMeasure(events, nominal, ppq, isFirst || isLast);
        if (layout.mismatch) mismatchCount++;
        if (layout.clipped) clippedCount++;
        const key = grand ? 'grand' : `part${staff.partIndex}`;
        const track = trackFor(key, grand ? 'Piano' : si.staffIds.length > 1 ? `Staff ${staff.partIndex + 1}` : 'Melody');
        const voice = grand ? staff.partIndex : 0;
        const ckey = `${key}:${voice}`;
        const heads = layout.placed.flatMap((p) => (p.event.kind === 'cluster' ? p.event.cluster.heads : []));
        const { pitched, carry } = pitchMeasure(heads, staff, clefs[sPos], fifths, carryByStaffKey.get(ckey) ?? new Map());
        carryByStaffKey.set(ckey, carry);
        const byHead = new Map(pitched.map((p) => [p.head, p]));
        for (const pe of layout.placed) {
          if (pe.event.kind !== 'cluster') continue;
          const c = pe.event.cluster;
          const isFirstCluster = !firstDone.has(ckey);
          c.heads.forEach((h, hi) => {
            const p = byHead.get(h);
            if (!p) return;
            const id = newNoteId();
            let dur = quantizeTicks(c.durations[hi] * pe.scale, pe.grid);
            dur = Math.max(pe.grid, Math.min(dur, Math.max(pe.grid, nominal - pe.start)));
            const lowered = layout.clipped ? 0.6 : layout.scaled ? 0.75 : layout.repaired ? 0.7 : layout.tuplet && layout.mismatch ? 0.8 : layout.mismatch ? 0.85 : 1;
            const note: Note = {
              id,
              pitch: p.midi,
              start: start + pe.start,
              duration: dur,
              velocity: 90,
              voice,
              spelling: p.spelling,
              confidence: Math.max(0.05, Math.min(1, h.confidence * lowered)),
            };
            if (h.tiedFromPrevious) note.tiedFromPrevious = true;
            if (isFirstCluster && pendingTie.get(ckey) === p.midi) note.tiedFromPrevious = true;
            if (sym.tieOut === h || sym.tieOuts?.includes(h)) nextPending.set(ckey, p.midi);
            track.notes.push(note);
            boxes[id] = [boxOf(si.page, h.x0, h.y0, h.x1, h.y1)];
          });
          firstDone.add(ckey);
        }
      });
      cursor += nominal;
      measureNo++;
    }
    pendingTie = nextPending;
  }

  const trackList = [...tracks.values()];
  for (const t of trackList) t.notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  if (trackList.length > 0) trackList[0].isGuitarTarget = true;
  score.tracks = trackList;
  if (mismatchCount > 0) {
    warnings.push(`${mismatchCount} measure(s) did not add up to the time signature; durations were adjusted. Check rhythms.`);
  }
  if (clippedCount > 0) warnings.push(`${clippedCount} measure(s) could not be fitted to the time signature and were clipped at the barline.`);
  if (slashMeasures > 0) warnings.push(`${slashMeasures} chord-slash measure(s) were skipped (no notes).`);
  if (trackList.every((t) => t.notes.length === 0)) warnings.push('No notes were recognized. Try a cleaner, higher-resolution scan.');
  score.meta.warnings = [...new Set(warnings)];
  score.meta.omrBoxes = boxes;
  score.meta.omrMeasures = measureNo;
  return score;
}

function staffHasSlashIn(sym: StaffSymbols, measures: RhythmEvent[][] | undefined, m: number): boolean {
  void measures;
  // a measure is a slash measure when at least two slash marks fall between its barlines
  const bars = sym.barlines;
  const lo = m === 0 ? -Infinity : bars[m - 1] ?? Infinity;
  const hi = m < bars.length ? bars[m] : Infinity;
  return (sym.slashes ?? []).filter((s) => s.cx >= lo && s.cx < hi).length >= 2;
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

