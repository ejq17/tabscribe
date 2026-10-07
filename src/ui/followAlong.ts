import type { Score } from '../core';

/** A source-image region (fractions 0..1 of the page) active over [start, end). */
export interface TimelineEntry {
  start: number;
  end: number;
  noteId: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Timeline {
  /** sorted by start */
  entries: TimelineEntry[];
  maxDur: number;
}

interface RawBox { page: number; x: number; y: number; w: number; h: number }
export type PageSizes = Record<number, { w: number; h: number }>;

/** Boxes may be normalized (0..1) or in source pixels. Returns page fractions, or null if pixel size is unknown. */
export function normBox(b: RawBox, size?: { w: number; h: number }): RawBox | null {
  const norm = b.x <= 1 && b.y <= 1 && b.w <= 1 && b.h <= 1;
  if (norm) return b;
  if (!size || !size.w || !size.h) return null;
  return { page: b.page, x: b.x / size.w, y: b.y / size.h, w: b.w / size.w, h: b.h / size.h };
}

export function buildTimeline(score: Score | null, sizes: PageSizes = {}): Timeline {
  const entries: TimelineEntry[] = [];
  if (!score) return { entries, maxDur: 0 };
  const boxes = (score.meta as { omrBoxes?: Record<string, RawBox | RawBox[]> }).omrBoxes;
  if (!boxes) return { entries, maxDur: 0 };
  for (const t of score.tracks)
    for (const n of t.notes) {
      const raw = boxes[n.id];
      const b0 = Array.isArray(raw) ? raw[0] : raw;
      if (!b0) continue;
      const b = normBox(b0, sizes[b0.page]);
      if (!b) continue;
      entries.push({ start: n.start, end: n.start + Math.max(1, n.duration), noteId: n.id, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h });
    }
  entries.sort((a, b) => a.start - b.start);

  // Slash (chord-only) measures: span the gap between the neighbouring note boxes when they share a row.
  const slashes = score.meta.omrSlashMeasures ?? [];
  const slashEntries: TimelineEntry[] = [];
  for (const s of slashes) {
    const sEnd = s.tick + s.length;
    let prev: TimelineEntry | undefined;
    let next: TimelineEntry | undefined;
    for (const e of entries) {
      if (e.start < s.tick) prev = e;
      else if (e.start >= sEnd) {
        next = e;
        break;
      }
    }
    const anchor = prev ?? next;
    if (!anchor) continue;
    let x = anchor.x + anchor.w;
    let right = Math.min(1, x + 0.1);
    if (prev && next && prev.page === next.page && next.x > prev.x + prev.w) right = next.x;
    else if (prev && next && prev.page === next.page) right = Math.min(0.97, Math.max(right, prev.x + prev.w + 0.05));
    if (!prev && next) {
      right = next.x;
      x = Math.max(0, right - 0.1);
    }
    slashEntries.push({ start: s.tick, end: sEnd, noteId: '', page: anchor.page, x, y: anchor.y, w: Math.max(0.01, right - x), h: anchor.h });
  }
  const all = slashEntries.length ? [...entries, ...slashEntries].sort((a, b) => a.start - b.start) : entries;
  let maxDur = 0;
  for (const e of all) maxDur = Math.max(maxDur, e.end - e.start);
  return { entries: all, maxDur };
}

/** All entries with start <= tick < end. Binary search + bounded backward scan. */
export function activeAt(tl: Timeline, tick: number): TimelineEntry[] {
  const e = tl.entries;
  let lo = 0;
  let hi = e.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (e[mid].start <= tick) lo = mid + 1;
    else hi = mid;
  }
  const out: TimelineEntry[] = [];
  for (let i = lo - 1; i >= 0; i--) {
    if (e[i].start + tl.maxDur <= tick) break;
    if (e[i].end > tick) out.push(e[i]);
  }
  return out.reverse();
}

/**
 * Tick for a click at page fraction (fx, fy): the containing box's start, else the nearest box by x
 * within the staff row closest in y. Null when the page has no boxes.
 */
export function tickAtPoint(tl: Timeline, page: number, fx: number, fy: number): number | null {
  const onPage = tl.entries.filter((e) => e.page === page && e.noteId !== '');
  if (!onPage.length) return null;
  for (const e of onPage) if (fx >= e.x && fx <= e.x + e.w && fy >= e.y && fy <= e.y + e.h) return e.start;
  let best = onPage[0];
  let bestDy = Infinity;
  for (const e of onPage) {
    const dy = Math.abs(e.y + e.h / 2 - fy);
    if (dy < bestDy) {
      bestDy = dy;
      best = e;
    }
  }
  const rowTol = Math.max(best.h, 0.02) * 1.5;
  let pick = best;
  let bestDx = Infinity;
  for (const e of onPage) {
    if (Math.abs(e.y + e.h / 2 - (best.y + best.h / 2)) > rowTol) continue;
    const dx = Math.abs(e.x + e.w / 2 - fx);
    if (dx < bestDx) {
      bestDx = dx;
      pick = e;
    }
  }
  return pick.start;
}
