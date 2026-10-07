import type { AccidentalKind, Binary, ClefKind, Notehead, RestKind, RestSym, Staff, StaffSymbols, StemInfo } from './types';
import { lineY, removeStaffLines } from './staves';
import { detectAccidentals } from './accidentals';
import { detectTies } from './ties';
import { findHollowHeads, findMultiRestBars, findStrokes, readKeySignature, type GImg } from './glyphs';

/** Local crop of the page with its page-coordinate origin. */
interface Img {
  w: number;
  h: number;
  d: Uint8Array;
  ox: number;
  oy: number;
}

export interface Comp {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

export function labelComponents(w: number, h: number, d: Uint8Array): { labels: Int32Array; comps: Comp[] } {
  const labels = new Int32Array(w * h);
  const comps: Comp[] = [];
  const stack = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i] || labels[i]) continue;
      const id = comps.length + 1;
      let sp = 0;
      stack[sp++] = i;
      labels[i] = id;
      const c: Comp = { id, x0: x, y0: y, x1: x, y1: y, area: 0 };
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % w;
        const py = (p - px) / w;
        c.area++;
        if (px < c.x0) c.x0 = px;
        if (px > c.x1) c.x1 = px;
        if (py < c.y0) c.y0 = py;
        if (py > c.y1) c.y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (d[ni] && !labels[ni]) {
              labels[ni] = id;
              stack[sp++] = ni;
            }
          }
        }
      }
      comps.push(c);
    }
  }
  return { labels, comps };
}

interface Hole {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** Enclosed background regions (4-connectivity) inside a component's bounding box. */
function findHoles(w: number, labels: Int32Array, c: Comp): Hole[] {
  const bw = c.x1 - c.x0 + 3;
  const bh = c.y1 - c.y0 + 3;
  const seen = new Uint8Array(bw * bh);
  const pass = (gx: number, gy: number): boolean => {
    const x = gx - 1 + c.x0;
    const y = gy - 1 + c.y0;
    if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) return true;
    return labels[y * w + x] !== c.id;
  };
  const stack: number[] = [0];
  seen[0] = 1;
  const nb = [1, 0, -1, 0, 0, 1, 0, -1];
  while (stack.length) {
    const p = stack.pop()!;
    const gx = p % bw;
    const gy = (p - gx) / bw;
    for (let k = 0; k < 8; k += 2) {
      const nx = gx + nb[k];
      const ny = gy + nb[k + 1];
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const ni = ny * bw + nx;
      if (seen[ni] || !pass(nx, ny)) continue;
      seen[ni] = 1;
      stack.push(ni);
    }
  }
  const holes: Hole[] = [];
  for (let gy = 1; gy < bh - 1; gy++) {
    for (let gx = 1; gx < bw - 1; gx++) {
      const i = gy * bw + gx;
      if (seen[i] || !pass(gx, gy)) continue;
      const hole: Hole = { x0: gx, y0: gy, x1: gx, y1: gy, area: 0 };
      seen[i] = 1;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % bw;
        const py = (p - px) / bw;
        hole.area++;
        if (px < hole.x0) hole.x0 = px;
        if (px > hole.x1) hole.x1 = px;
        if (py < hole.y0) hole.y0 = py;
        if (py > hole.y1) hole.y1 = py;
        for (let k = 0; k < 8; k += 2) {
          const nx = px + nb[k];
          const ny = py + nb[k + 1];
          const ni = ny * bw + nx;
          if (seen[ni] || !pass(nx, ny)) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      holes.push({
        x0: hole.x0 - 1 + c.x0,
        x1: hole.x1 - 1 + c.x0,
        y0: hole.y0 - 1 + c.y0,
        y1: hole.y1 - 1 + c.y0,
        area: hole.area,
      });
    }
  }
  return holes;
}

function runLengths(w: number, h: number, d: Uint8Array, vertical: boolean): Uint16Array {
  const out = new Uint16Array(w * h);
  if (vertical) {
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!d[y * w + x]) {
          y++;
          continue;
        }
        const s = y;
        while (y < h && d[y * w + x]) y++;
        const len = Math.min(65535, y - s);
        for (let k = s; k < y; k++) out[k * w + x] = len;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!d[y * w + x]) {
          x++;
          continue;
        }
        const s = x;
        while (x < w && d[y * w + x]) x++;
        const len = Math.min(65535, x - s);
        for (let k = s; k < x; k++) out[y * w + k] = len;
      }
    }
  }
  return out;
}

function removeLedgerLines(src: Img, staff: Staff): Uint8Array {
  const { w, h, d: data, ox, oy } = src;
  const out = new Uint8Array(data);
  const sp = staff.staffSpace;
  const limit = staff.lineThickness + 2;
  const half = Math.ceil(staff.lineThickness / 2) + 1;
  const rowsDone = new Set<number>();
  const hrunRow = new Map<number, Uint16Array>();
  const getHrun = (y: number): Uint16Array => {
    let r = hrunRow.get(y);
    if (r) return r;
    r = new Uint16Array(w);
    let x = 0;
    while (x < w) {
      if (!data[y * w + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && data[y * w + x]) x++;
      for (let k = s; k < x; k++) r[k] = x - s;
    }
    hrunRow.set(y, r);
    return r;
  };
  void rowsDone;
  for (const dir of [-1, 1]) {
    const li = dir < 0 ? 0 : 4;
    for (let k = 1; k <= 6; k++) {
      for (let x = 0; x < w; x++) {
        const px = x + ox;
        if (px < staff.left - 2 * sp || px > staff.right + 2 * sp) continue;
        const cy = Math.round(lineY(staff, li, px) + dir * k * sp) - oy;
        for (let y = Math.max(0, cy - half); y <= Math.min(h - 1, cy + half); y++) {
          if (!data[y * w + x]) continue;
          if (getHrun(y)[x] < 0.9 * sp) continue;
          let up = 0;
          let yy = y - 1;
          while (yy >= 0 && data[yy * w + x] && up <= limit) {
            up++;
            yy--;
          }
          let dn = 0;
          yy = y + 1;
          while (yy < h && data[yy * w + x] && dn <= limit) {
            dn++;
            yy++;
          }
          if (up + dn + 1 <= limit) out[y * w + x] = 0;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shape helpers

interface ShapeStats {
  w: number;
  h: number;
  fill: number;
  /** vertical strokes: columns whose longest vertical run >= 0.55 h, grouped */
  strokes: { x0: number; x1: number; top: number; bottom: number }[];
  maxVRunFrac: number;
}

function shapeStats(img: Img, labels: Int32Array, c: Comp): ShapeStats {
  const w = c.x1 - c.x0 + 1;
  const h = c.y1 - c.y0 + 1;
  const colRun: number[] = [];
  const colTop: number[] = [];
  let maxRun = 0;
  for (let x = c.x0; x <= c.x1; x++) {
    let best = 0;
    let bestTop = c.y0;
    let run = 0;
    let start = c.y0;
    for (let y = c.y0; y <= c.y1 + 1; y++) {
      if (y <= c.y1 && labels[y * img.w + x] === c.id) {
        if (run === 0) start = y;
        run++;
      } else {
        if (run > best) {
          best = run;
          bestTop = start;
        }
        run = 0;
      }
    }
    colRun.push(best);
    colTop.push(bestTop);
    if (best > maxRun) maxRun = best;
  }
  const strokes: ShapeStats['strokes'] = [];
  let cur: ShapeStats['strokes'][number] | null = null;
  for (let i = 0; i < colRun.length; i++) {
    if (colRun[i] >= 0.55 * h) {
      if (!cur) cur = { x0: i, x1: i, top: colTop[i], bottom: colTop[i] + colRun[i] - 1 };
      else {
        cur.x1 = i;
        cur.top = Math.min(cur.top, colTop[i]);
        cur.bottom = Math.max(cur.bottom, colTop[i] + colRun[i] - 1);
      }
    } else if (cur) {
      strokes.push(cur);
      cur = null;
    }
  }
  if (cur) strokes.push(cur);
  return { w, h, fill: c.area / (w * h), strokes, maxVRunFrac: maxRun / h };
}

function classifyAccidental(s: ShapeStats, d: number, t: number): { kind: AccidentalKind; conf: number } | null {
  if (s.h < 1.4 * d || s.h > 3.7 * d || s.w < 0.3 * d || s.w > 1.6 * d) return null;
  const thin = (st: { x0: number; x1: number }) => st.x1 - st.x0 + 1 <= Math.max(3 * t + 2, 0.45 * s.w);
  const strokes = s.strokes.filter(thin);
  if (strokes.length === 2) {
    const [a, b] = strokes;
    const topDiff = Math.abs(a.top - b.top);
    const gap = b.x0 - a.x1;
    if (gap < 0.12 * d) return null;
    if (topDiff >= 0.2 * s.h) return { kind: 'natural', conf: 0.7 };
    return { kind: 'sharp', conf: 0.85 };
  }
  if (strokes.length === 1) {
    const a = strokes[0];
    const centre = (a.x0 + a.x1) / 2;
    if (centre < 0.4 * s.w && s.w >= 0.4 * d && s.fill > 0.25 && a.bottom - a.top + 1 >= 0.8 * s.h) {
      return { kind: 'flat', conf: 0.8 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Digit reading for time signatures

/** Classify a digit blob (0-9) with simple topological/geometry rules; returns -1 when unsure. */
export function classifyDigit(d: Uint8Array, w: number, h: number): number {
  // d: tight crop (w x h) of the digit, 1 = ink
  const { labels, comps } = labelComponents(w, h, d);
  if (comps.length === 0) return -1;
  let big = comps[0];
  for (const c of comps) if (c.area > big.area) big = c;
  const holes = findHoles(w, labels, big).filter((hl) => hl.area >= 0.012 * w * h && hl.area >= 3);
  const colRunFrac = (x: number): number => {
    let best = 0;
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (d[y * w + x]) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    return best / h;
  };
  const rowRunFrac = (y0: number, y1: number): number => {
    let best = 0;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        if (d[y * w + x]) {
          run++;
          if (run > best) best = run;
        } else run = 0;
      }
    }
    return best / w;
  };
  let maxCol = 0;
  let maxColX = 0;
  for (let x = 0; x < w; x++) {
    const f = colRunFrac(x);
    if (f > maxCol) {
      maxCol = f;
      maxColX = x;
    }
  }
  const rowsBand = Math.max(1, Math.round(0.14 * h));
  const topRun = rowRunFrac(0, rowsBand - 1);
  const botRun = rowRunFrac(h - rowsBand, h - 1);
  // a 1 (with or without flag / base serif): one stem running nearly the full height in a narrow box
  if (w < 0.55 * h && maxCol >= 0.9 && holes.length === 0) return 1;
  // A "4" in a bold sans face: a full-width crossbar at 55-82% of the height and, below it, ONE narrow stem on the right
  // (above the bar there is a diagonal reaching the left edge). Staff-line removal nicks the stem or the triangle so
  // the hole / long-column tests below can fail, whereas this survives. The ink below the bar must span < 0.45 w and
  // sit right of centre (a 6 / 8 / 0 / 9 has its loop sides across the whole width there; 2 / 5 / 7 have no such bar). The crossbar must also stick
  // out to the right of the stem (hi <= 0.9 w): a 9's tail ends flush with its loop.
  {
    let barA = -1;
    let barB = -1;
    for (let y = Math.round(0.55 * h); y <= Math.round(0.82 * h); y++) {
      if (rowRunFrac(y, y) >= 0.75) {
        if (barA < 0) barA = y;
        barB = y;
      } else if (barA >= 0) break;
    }
    // a 9 / 6 / 0 / 8 loop is a WIDE hole (>= 0.3 w); a 4's triangle is a thin sliver
    const wideHole = holes.some((hl) => hl.x1 - hl.x0 + 1 >= 0.3 * w);
    if (barA >= 0 && !wideHole) {
      // only the first rows below the bar: a staff line crossing the stem near the bottom leaves a wide residue row there
      const yEnd = Math.min(Math.floor(0.9 * h) - 1, barB + 3);
      let lo = w;
      let hi = -1;
      for (let y = barB + 1; y <= yEnd; y++)
        for (let x = 0; x < w; x++)
          if (d[y * w + x]) {
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
      let leftDiag = false;
      for (let y = Math.round(0.35 * h); y < barA && !leftDiag; y++) for (let x = 0; x < Math.round(0.3 * w) && !leftDiag; x++) if (d[y * w + x]) leftDiag = true;
      if (hi >= lo && yEnd - (barB + 1) >= 1 && hi - lo + 1 <= 0.45 * w && (lo + hi) / 2 > 0.5 * w && hi <= 0.9 * w && leftDiag) return 4;
    }
  }
  if (holes.length >= 2) return 8;
  if (holes.length === 1) {
    const hc = (holes[0].y0 + holes[0].y1) / 2 / h;
    // the 4's stem is left of the right edge (its crossbar sticks out); a 9's right stroke IS the right edge
    if (maxCol >= 0.85 && maxColX > 0.5 * w && maxColX <= 0.88 * w) return 4;
    const hf = (holes[0].y1 - holes[0].y0 + 1) / h;
    if (hc >= 0.42 && hc <= 0.58 && hf >= 0.4) return 0; // a long hole centred in the box: zero
    if (hc >= 0.5) return 6;
    return 9;
  }
  // no holes
  if (w < 0.4 * h && maxCol > 0.8) return 1;
  if (maxCol >= 0.85 && maxColX > 0.55 * w && maxColX <= 0.88 * w && botRun < 0.5) return 4; // open-top 4
  if (botRun >= 0.8 && topRun < 0.9) return 2;
  if (topRun >= 0.85 && botRun < 0.4) return 7;
  // A 3 with a flat top bar (bold / MuseScore faces) looks like a 5 from the top. But its upper bowl closes the RIGHT side
  // at 20-40% of the height, whereas a 5 is open there (bar, then a stem on the left only).
  let rightCov = 0;
  {
    let n = 0;
    for (let y = Math.round(0.2 * h); y <= Math.round(0.4 * h); y++) {
      n++;
      for (let x = Math.ceil(0.65 * w); x < w; x++)
        if (d[y * w + x]) {
          rightCov++;
          break;
        }
    }
    rightCov = n ? rightCov / n : 0;
  }
  if (topRun >= 0.85) return rightCov >= 0.8 && botRun >= 0.4 && holes.length === 0 ? 3 : 5;
  // a 5 whose top bar is shorter than the bowl: its stem makes the upper-left a solid column, a 3 is open there
  {
    let rowsWithLeft = 0;
    let rowsN = 0;
    for (let y = Math.round(0.15 * h); y <= Math.round(0.42 * h); y++) {
      rowsN++;
      for (let x = 0; x < Math.max(2, Math.round(0.3 * w)); x++) if (d[y * w + x]) {
        rowsWithLeft++;
        break;
      }
    }
    if (topRun >= 0.6 && rowsN > 0 && rowsWithLeft >= 0.85 * rowsN && botRun < 0.8 && rightCov < 0.6) return 5;
  }
  if (botRun < 0.8) return 3;
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------

export interface AnalyzeOptions {
  defaultClef: ClefKind;
  /** y-extents (page coords) this staff owns (clipped against neighbouring staves) */
  y0: number;
  y1: number;
  /** outer vertical limits (bottom of the staff above / top of the staff below) for far-away marks such as tuplet brackets */
  limitTop?: number;
  limitBottom?: number;
}

/** Read one digit component (0-9) with the topological classifier; -1 when unsure. */
function readDigitComp(labels: Int32Array, W: number, c: Comp): number {
  const w = c.x1 - c.x0 + 1;
  const h = c.y1 - c.y0 + 1;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = labels[(c.y0 + y) * W + c.x0 + x] === c.id ? 1 : 0;
  const v = classifyDigit(g, w, h);
  if (v !== 3) return v;
  // a "3" bulges to the right at both the top and the bottom (an accent chevron ">" only has its apex in the middle)
  const band = Math.max(1, Math.round(0.3 * h));
  const fillRight = (ya: number, yb: number): number => {
    let n = 0;
    let t = 0;
    for (let y = ya; y < yb; y++)
      for (let x = Math.floor(0.55 * w); x < w; x++) {
        t++;
        n += g[y * w + x];
      }
    return t ? n / t : 0;
  };
  const midFill = (() => {
    let n = 0;
    let t = 0;
    for (let y = Math.floor(0.4 * h); y < Math.ceil(0.6 * h); y++)
      for (let x = 0; x < Math.floor(0.3 * w); x++) {
        t++;
        n += g[y * w + x];
      }
    return t ? n / t : 0;
  })();
  return fillRight(0, band) >= 0.3 && fillRight(h - band, h) >= 0.3 && midFill <= 0.5 ? 3 : -1;
}

/**
 * Triplet brackets: a thin horizontal line with a tick at each end and a "3" in a gap in its middle (or just above /
 * below it). Returns the x extent (local coordinates) of every bracket found, above or below the staff.
 */
function findTupletBrackets(comps: Comp[], labels: Int32Array, W: number, d: number, topL: number, botL: number, minX: number, avoid: { x0: number; x1: number }[]): { brackets: { x0: number; x1: number; n: number; y0: number; y1: number }[]; loose: { cx: number; y0: number; y1: number; above: boolean }[] } {
  const out: { x0: number; x1: number; n: number; y0: number; y1: number }[] = [];
  const loose: { cx: number; y0: number; y1: number; above: boolean }[] = [];
  const ww = (c: Comp) => c.x1 - c.x0 + 1;
  const hh = (c: Comp) => c.y1 - c.y0 + 1;
  const digits = comps.filter(
    (c) => c.x0 >= minX && !avoid.some((a) => c.x1 >= a.x0 && c.x0 <= a.x1) && hh(c) >= 0.55 * d && hh(c) <= 1.9 * d && ww(c) >= 0.3 * d && ww(c) <= 1.4 * d && (c.y1 < topL - 0.2 * d || c.y0 > botL + 0.2 * d) && c.area >= 0.12 * d * d,
  );
  const pieces = comps.filter((c) => c.x0 >= minX - 2 * d && ww(c) >= 0.9 * d && hh(c) >= 0.35 * d && hh(c) <= 1.7 * d && c.area / (ww(c) * hh(c)) <= 0.55 && (c.y1 < topL - 0.2 * d || c.y0 > botL + 0.2 * d));
  if (digits.length === 0) return { brackets: out, loose };
  // vertical ink run at the end of a piece (a bracket tick), looking from the line row away from it
  const tickAt = (p: Comp, x: number, dir: 1 | -1): number => {
    let best = 0;
    for (let xx = x - 1; xx <= x + 1; xx++) {
      let n = 0;
      for (let yy = dir > 0 ? p.y0 : p.y1; yy >= p.y0 && yy <= p.y1; yy += dir) {
        if (labels[yy * W + xx] === p.id) n++;
        else if (n > 0) break;
      }
      if (n > best) best = n;
    }
    return best;
  };
  const tickEnds = (p: Comp, side: 'l' | 'r'): boolean => {
    const x = side === 'l' ? p.x0 + 1 : p.x1 - 1;
    // ticks hang down from an upper bracket (the line is the top row) and rise from a lower one
    return tickAt(p, x, 1) >= 0.4 * d || tickAt(p, x, -1) >= 0.4 * d;
  };
  for (const g of digits) {
    if (readDigitComp(labels, W, g) !== 3) continue;
    const gcy = (g.y0 + g.y1) / 2;
    const near = (p: Comp) => Math.min(Math.abs(p.y0 - gcy), Math.abs(p.y1 - gcy)) <= 0.9 * d;
    // broken bracket: a piece left of the digit and one right of it
    const L = pieces
      .filter((p) => near(p) && p.x1 <= g.x0 + 0.3 * d && p.x1 >= g.x0 - 1.8 * d && tickEnds(p, 'l'))
      .sort((a, b) => b.x1 - a.x1)[0];
    const R = pieces
      .filter((p) => near(p) && p.x0 >= g.x1 - 0.3 * d && p.x0 <= g.x1 + 1.8 * d && tickEnds(p, 'r'))
      .sort((a, b) => a.x0 - b.x0)[0];
    if (L && R) {
      out.push({ x0: L.x0, x1: R.x1, n: 3, y0: Math.min(L.y0, R.y0), y1: Math.max(L.y1, R.y1) });
      continue;
    }
    const loneAbove = g.y1 < topL;
    // continuous bracket with the digit just above / below its middle
    const C = pieces.find(
      (p) => ww(p) >= 2.0 * d && p.x0 <= g.x0 && p.x1 >= g.x1 && tickEnds(p, 'l') && tickEnds(p, 'r') && (Math.abs(g.y1 - p.y0) <= 1.6 * d || Math.abs(g.y0 - p.y1) <= 1.6 * d),
    );
    if (C) out.push({ x0: C.x0, x1: C.x1, n: 3, y0: C.y0, y1: C.y1 });
    else if (hh(g) <= 1.6 * d && !comps.some((o) => o !== g && o.x1 >= g.x0 - 0.9 * d && o.x0 <= g.x1 + 0.9 * d && o.y1 >= g.y0 - 0.8 * d && o.y0 <= g.y1 + 0.8 * d)) loose.push({ cx: (g.x0 + g.x1) / 2, y0: g.y0, y1: g.y1, above: loneAbove });
  }
  return { brackets: out, loose };
}

export function cropBinary(b: Binary, x0: number, y0: number, x1: number, y1: number): Binary {
  const xa = Math.max(0, x0);
  const ya = Math.max(0, y0);
  const xb = Math.min(b.width, x1);
  const yb = Math.min(b.height, y1);
  const w = Math.max(0, xb - xa);
  const h = Math.max(0, yb - ya);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const so = (y + ya) * b.width + xa;
    out.set(b.data.subarray(so, so + w), y * w);
  }
  return { width: w, height: h, data: out };
}

interface StemCand {
  x: number;
  top: number;
  bottom: number;
}

/** Analyze one staff: detect clef, key/time signature, noteheads, stems, beams, rests, barlines. */
export function analyzeStaff(bin: Binary, staff: Staff, opts: AnalyzeOptions): StaffSymbols {
  const d = staff.staffSpace;
  const t = staff.lineThickness;
  const warnings: string[] = [];
  const empty = (): StaffSymbols => ({
    clef: staff.lowerOfGrand ? 'bass' : opts.defaultClef,
    clefDetected: false,
    keyFifths: 0,
    musicStart: staff.left,
    heads: [],
    stems: [],
    rests: [],
    barlines: [],
    warnings,
  });

  const rx0 = Math.max(0, Math.floor(staff.left - 0.3 * d));
  const rx1 = Math.min(bin.width, Math.ceil(staff.right + 1 + 0.3 * d));
  const ry0 = Math.max(0, Math.floor(Math.max(opts.y0, staff.top - 5.5 * d)));
  const ry1 = Math.min(bin.height, Math.ceil(Math.min(opts.y1, staff.bottom + 5.5 * d)));
  const crop = cropBinary(bin, rx0, ry0, rx1, ry1);
  if (crop.width < 8 || crop.height < 8) return empty();
  const src: Img = { w: crop.width, h: crop.height, d: crop.data, ox: rx0, oy: ry0 };
  const noLines = removeStaffLines(crop, staff, rx0, ry0);
  const clean: Img = { w: crop.width, h: crop.height, d: noLines.data, ox: rx0, oy: ry0 };
  clean.d = removeLedgerLines({ ...clean, d: clean.d }, staff);
  const W = clean.w;
  const H = clean.h;
  const ink = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && clean.d[y * W + x] === 1;
  void src;

  // notehead-sized solid blobs (opened mask) used to tell stems from barlines
  const preHeads: Comp[] = [];
  {
    const h0 = runLengths(clean.w, clean.h, clean.d, false);
    const v0 = runLengths(clean.w, clean.h, clean.d, true);
    const hm = Math.max(2, Math.round(0.5 * d));
    const vm = Math.max(2, Math.round(0.7 * d));
    const m0 = new Uint8Array(clean.w * clean.h);
    for (let i = 0; i < m0.length; i++) m0[i] = clean.d[i] && h0[i] >= hm && v0[i] >= vm ? 1 : 0;
    for (const c of labelComponents(clean.w, clean.h, m0).comps) {
      const w0 = c.x1 - c.x0 + 1;
      const hh0 = c.y1 - c.y0 + 1;
      if (c.area >= 0.4 * d * d && w0 >= 0.8 * d && hh0 >= 0.6 * d && w0 <= 1.8 * d) preHeads.push(c);
    }
  }

  // ---- barlines: columns that are inked over the whole staff height (and are not a stem), erased before labelling
  const barLocal: number[] = [];
  {
    const yA = Math.max(0, Math.round(staff.top - ry0));
    const yB = Math.min(H - 1, Math.round(staff.bottom - ry0));
    const full = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let y = yA; y <= yB; y++) c += clean.d[y * W + x];
      full[x] = c >= 0.96 * (yB - yA + 1) ? 1 : 0;
    }
    const boxFill = (xa: number, xb: number, ya: number, yb: number, skipA: number, skipB: number): number => {
      let c = 0;
      let n = 0;
      for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y++)
        for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) {
          if (x >= skipA && x <= skipB) continue;
          n++;
          c += clean.d[y * W + x];
        }
      return n ? c / n : 0;
    };
    let x = 0;
    while (x < W) {
      if (!full[x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < W && full[x]) x++;
      const e = x - 1;
      const bw = e - s + 1;
      if (bw > Math.max(1.2 * d, 3 * t)) continue;
      const hw = Math.round(0.6 * d);
      const hv = Math.round(0.5 * d);
      const topFill = boxFill(s - hw, e + hw, yA - hv, yA + hv, s - 1, e + 1);
      const botFill = boxFill(s - hw, e + hw, yB - hv, yB + hv, s - 1, e + 1);
      if (topFill >= 0.35 || botFill >= 0.35) continue; // a stem with its notehead
      // a barline ends at the outer staff lines (or runs on to the neighbouring staff); a stem sticks out into free space
      {
        const xm = Math.min(W - 1, Math.max(0, Math.floor((s + e) / 2)));
        const run = (y0: number, dy: number): number => {
          let n = 0;
          let miss = 0;
          for (let y = y0; y >= 0 && y < H; y += dy) {
            if (clean.d[y * W + xm]) {
              n++;
              miss = 0;
            } else if (++miss > 1) break;
          }
          return n;
        };
        // a stem is touched by a notehead-sized solid blob; a barline is not
        let touched = false;
        for (const m of preHeads) {
          if (m.x0 <= e + 2 && m.x1 >= s - 2 && m.y1 >= yA - 1.3 * d && m.y0 <= yB + 1.3 * d) {
            touched = true;
            break;
          }
        }
        if (touched) continue;
        const up = run(yA - 1, -1);
        const down = run(yB + 1, 1);
        const atLeft = (s + e) / 2 <= staff.left - rx0 + 1.0 * d;
        if (!atLeft && up > 0.55 * d && yA - up > 1) continue;
        if (!atLeft && down > 0.55 * d && yB + down < H - 2) continue;
        // A barline stands in clear space: the columns 0.5..1.2 d to either side hold (almost) no ink along the staff.
        // The aligned edges of a stacked time-signature "3 over 4" (or any glyph whose strokes happen to line up through
        // all five lines) have the digit body right next to them.
        if (!atLeft) {
          const side = (xa: number, xb: number): number => {
            let n = 0;
            let t2 = 0;
            for (let y = yA; y <= yB; y++)
              for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) {
                t2++;
                n += clean.d[y * W + x];
              }
            return t2 ? n / t2 : 0;
          };
          // only the LEFT side counts: the digit body sits left of the aligned stem edge, whereas a roll sign / accidental /
          // clef change can legitimately follow a barline. A stem (2 px) in the band stays well under the density limit.
          const dl = side(s - Math.round(1.2 * d), s - Math.round(0.5 * d));
          if (dl >= 0.2) continue;
        }
      }
      barLocal.push((s + e + 1) / 2);
      for (let y = Math.max(0, yA - 2); y <= Math.min(H - 1, yB + 2); y++) {
        // keep thin horizontal strokes (ties/slurs/beams) that cross the bar: ink on both sides within +-1 row
        let bridge = false;
        if (s - 1 >= 0 && e + 1 < W) {
          let l = false;
          let r = false;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            if (clean.d[yy * W + s - 1]) l = true;
            if (clean.d[yy * W + e + 1]) r = true;
          }
          bridge = l && r && !(topFill >= 0.35);
        }
        if (!bridge) for (let xx = s; xx <= e; xx++) clean.d[y * W + xx] = 0;
      }
    }
  }

  const { labels, comps } = labelComponents(W, H, clean.d);
  const lines = staff.lines;
  // page → local
  const ly = (v: number) => v - ry0;
  const lx = (v: number) => v - rx0;
  const topL = ly(staff.top);
  const botL = ly(staff.bottom);
  const midL = ly(lines[2]);

  // ---- barline-like comps
  const isBarline = (c: Comp): boolean => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    return (
      w <= Math.max(0.9 * d, 2 * t + 2) &&
      h >= 3.6 * d &&
      c.y0 <= topL + 0.4 * d &&
      c.y1 >= botL - 0.4 * d &&
      c.area / (w * h) >= 0.7 &&
      h / w >= 4
    );
  };

  // ---- clef zone: the (possibly fragmented by line removal) glyph at the staff start
  // a measure number printed in the left margin (digits left of the staff, <3 d tall) is not part of the clef zone: it
  // used to start the zone and end it again at the gap before the real clef
  const sortedAll = comps
    .filter((c) => !isBarline(c) && c.area >= 0.1 * d * d && !(c.x1 <= lx(staff.left) + 0.5 * d && c.y1 - c.y0 + 1 < 3 * d))
    // the system line joining the staves (cut by the crop / neighbour clip so it does not span this staff): a thin vertical
    // stroke right at the staff start, which would otherwise open the zone and end it again at the gap before the clef
    .filter((c) => !(c.x0 <= lx(staff.left) + 1.0 * d && c.x1 - c.x0 + 1 <= Math.max(2 * t + 1, 0.3 * d) && c.y1 - c.y0 + 1 >= 2.5 * d))
    .sort((a, b) => a.x0 - b.x0);
  let zone: { x0: number; x1: number; y0: number; y1: number; ids: Set<number> } | null = null;
  for (const c of sortedAll) {
    if (!zone) {
      if (c.x0 > lx(staff.left) + 3.2 * d) break;
      zone = { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, ids: new Set([c.id]) };
    } else if (c.x0 <= zone.x1 + 0.3 * d) {
      zone.x1 = Math.max(zone.x1, c.x1);
      zone.y0 = Math.min(zone.y0, c.y0);
      zone.y1 = Math.max(zone.y1, c.y1);
      zone.ids.add(c.id);
    } else break;
  }
  if (zone && (zone.y1 - zone.y0 + 1 < 2.2 * d || zone.x1 - zone.x0 + 1 < 0.9 * d)) zone = null;
  const clefIds = zone ? zone.ids : new Set<number>();
  const isClefCand = (c: Comp): boolean => clefIds.has(c.id);


  // ---- run lengths (opened masks, slash cores)
  const hrun = runLengths(W, H, clean.d, false);
  const vrun = runLengths(W, H, clean.d, true);

  // ---- clef
  let clef: ClefKind = staff.lowerOfGrand ? 'bass' : opts.defaultClef;
  let clefDetected = false;
  let clefMissing = false;
  let clefEnd = lx(staff.left);
  const used = new Set<number>();
  if (zone) {
    const zh = zone.y1 - zone.y0 + 1;
    const spans = zone.y0 < topL - 0.5 * d && zone.y1 > botL + 0.5 * d;
    // a treble clef has one long vertical axis; a cluster of overlapping flats does not
    const clefStroke = findStrokes({ w: W, h: H, d: src.d }, zone.x0, zone.x1 + 1, Math.round(zone.y0), Math.round(zone.y1), Math.round(4.0 * d), Math.max(4, Math.round(0.9 * d)));
    // Real engravings (Emmentaler-style glyphs) draw the clef axis slanted and curving, so no column holds a long
    // straight run at all. The corroborating shape test is then: the glyph is a single tall object (>= 5.5 d, i.e.
    // a clef, not the 3.5 d flat/sharp/bass-clef family) that reaches past BOTH outer staff lines and leaves almost no
    // empty rows in between (a cluster of loose accidentals or a text blob has gaps; line removal costs a few rows).
    // chord symbols / text above the staff can chain onto the clef zone: judge the part of the glyph that is on the staff
    const body = comps.filter((c) => zone!.ids.has(c.id) && c.y1 >= topL && c.y0 <= botL);
    const bx0 = Math.min(...body.map((c) => c.x0));
    const bx1 = Math.max(...body.map((c) => c.x1));
    const by0 = Math.min(...body.map((c) => c.y0));
    const by1 = Math.max(...body.map((c) => c.y1));
    const bh = by1 - by0 + 1;
    const bSpans = by0 < topL - 0.5 * d && by1 > botL + 0.5 * d;
    let rowsInked = 0;
    for (let y = by0; y <= by1; y++) {
      let any = false;
      for (let x = bx0; x <= bx1 && !any; x++) if (clean.d[y * W + x]) any = true;
      if (any) rowsInked++;
    }
    const contiguousTall = body.length > 0 && bh >= 5.5 * d && bSpans && rowsInked >= 0.88 * bh && bx1 - bx0 + 1 <= 4.5 * d;
    if (((zh >= 5 * d || spans) && clefStroke.some((k) => k.x0 > staff.left - rx0 + 0.8 * d)) || contiguousTall) {
      for (const id of zone.ids) used.add(id);
      clefEnd = zone.x1;
      clef = 'treble';
      clefDetected = true;
    } else {
      // bass: two dots to the right of the bulb (either inside the merged zone or just beyond it)
      const zoneComps = comps.filter((c) => zone!.ids.has(c.id));
      const bulb = zoneComps.reduce((m, c) => (c.area > m.area ? c : m), zoneComps[0]);
      const dots = comps.filter((c) => {
        const w = c.x1 - c.x0 + 1;
        const hh2 = c.y1 - c.y0 + 1;
        return (
          c.id !== bulb.id &&
          w <= 0.7 * d &&
          hh2 <= 0.7 * d &&
          c.x0 >= bulb.x0 + 0.4 * (bulb.x1 - bulb.x0) &&
          c.x0 <= zone!.x1 + 1.2 * d &&
          c.y0 >= topL - 0.3 * d &&
          c.y1 <= botL + 0.3 * d
        );
      });
      if (dots.length >= 2 && zh < 5 * d) {
        for (const id of zone.ids) used.add(id);
        clefEnd = zone.x1;
        clef = 'bass';
        clefDetected = true;
        for (const dd of dots) {
          used.add(dd.id);
          clefEnd = Math.max(clefEnd, dd.x1);
        }
      } else if (staff.lowerOfGrand) {
        for (const id of zone.ids) used.add(id);
        clefEnd = zone.x1;
        clef = 'bass';
        clefDetected = true;
      } else {
        clefMissing = true;
      }
    }
  } else {
    clefMissing = true;
  }

  // ---- key signature (vertical-stroke based) and time signature
  const half = (c: Comp) => (c.y0 + c.y1) / 2;
  const hh = (c: Comp) => c.y1 - c.y0 + 1;
  const ww = (c: Comp) => c.x1 - c.x0 + 1;
  const gImg: GImg = { w: W, h: H, d: clean.d };
  const keyRead = readKeySignature(gImg, d, topL, botL, clefEnd);
  const keyFifths = keyRead.fifths;
  const keyEnd = keyFifths !== 0 ? keyRead.endX : clefEnd;
  /**
   * Read a time signature (stacked digits or C / cut C) whose glyphs start right of `keyEndX` and begin before `xMax`
   * (local x). Used for the prefix of the staff and for courtesy signatures after a double barline.
   */
  const readTimeSig = (keyEndX: number, xMax: number, ignoreUsed: boolean): { timeSig?: { numerator: number; denominator: number }; unreadable: boolean; x1: number } => {
    let timeSig: { numerator: number; denominator: number } | undefined;
    let timeSigUnreadable = false;
    const timeComps = new Set<number>();
    const winA = keyEndX + 0.1 * d;
    // NOTE (tried, not adopted): rebuilding this window from the RAW crop with only pure line pixels erased (run <= t + 1)
    // keeps arcs that lie on an outer line, but it made other pieces' digits misread (romanze 90% -> 40% pitch F1) and
    // still cannot restore an arc that lies completely ON the line, so the general cleaned image is used.
    // Stacked digits ("3" over "4") touch at the middle line once the line is removed and arrive as ONE ~4 d tall
    // component. Cut such a component at the middle line into two digit-sized pieces (the
    // pieces keep the label id, so reading and `used` bookkeeping work unchanged). Both halves must read as digits and
    // the rows must be wide (a stem + head never is), otherwise the component is left alone.
    const splitStacked = (c: Comp): Comp[] => {
      const w = ww(c);
      const h = hh(c);
      if (h < 3.2 * d || h > 4.8 * d || w > 1.9 * d || w < 0.5 * d) return [c];
      if (c.y0 < topL - 0.4 * d || c.y1 > botL + 0.4 * d) return [c];
      const rowInk = (y: number): number => {
        let n = 0;
        for (let x = c.x0; x <= c.x1; x++) if (labels[y * W + x] === c.id) n++;
        return n;
      };
      let wide = 0;
      for (let y = c.y0; y <= c.y1; y++) if (rowInk(y) >= 0.3 * w) wide++;
      if (wide < 0.7 * h) return [c];
      // the glyph halves meet ON the middle line: cut there (a minimum-ink search is fooled by the 3's waist)
      const cut = Math.ceil(midL);
      if (cut - c.y0 < 1.2 * d || c.y1 - cut < 1.2 * d) return [c];
      const mk = (ya: number, yb: number): Comp | null => {
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        let area = 0;
        for (let y = ya; y <= yb; y++)
          for (let x = c.x0; x <= c.x1; x++)
            if (labels[y * W + x] === c.id) {
              area++;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        return area ? { id: c.id, x0, x1, y0, y1, area } : null;
      };
      const up = mk(c.y0, cut - 1);
      const dn = mk(cut, c.y1);
      if (!up || !dn || readDigitComp(labels, W, up) < 0 || readDigitComp(labels, W, dn) < 0) return [c];
      return [up, dn];
    };
    const pre = comps
      .filter((c) => (ignoreUsed || !used.has(c.id)) && !isBarline(c) && c.area >= 0.1 * d * d && c.x0 >= winA && c.x0 <= xMax)
      .flatMap(splitStacked)
      .sort((a, b) => a.x0 - b.x0);
    const digitLike = (c: Comp) =>
      hh(c) >= 1.2 * d && hh(c) <= 2.6 * d && ww(c) <= 1.9 * d && c.y0 >= topL - 0.4 * d && c.y1 <= botL + 0.4 * d &&
      (c.y1 <= midL + 0.5 * d || c.y0 >= midL - 0.5 * d);
    const digits = pre.filter(digitLike);
    const topRow = digits.filter((c) => half(c) < midL).sort((a, b) => a.x0 - b.x0);
    const botRow = digits.filter((c) => half(c) >= midL).sort((a, b) => a.x0 - b.x0);
    // a C-shaped blob centred on the staff (common time; a vertical stroke through it = cut time)
    const isC = (c: Comp): boolean => {
      const w = ww(c);
      const h = hh(c);
      if (h < 1.5 * d || h > 4.4 * d || w < 0.8 * d || w > 2.1 * d) return false;
      if (Math.abs(half(c) - midL) > 0.8 * d) return false;
      if (c.y0 > ly(lines[1]) + 0.4 * d || c.y1 < ly(lines[3]) - 0.4 * d) return false;
      // left arc inked through the middle rows
      const yA = Math.round(midL - 0.45 * d);
      const yB = Math.round(midL + 0.45 * d);
      let leftRows = 0;
      let rightInk = 0;
      let rows = 0;
      const rw = Math.max(1, Math.round(0.22 * w));
      for (let y = yA; y <= yB; y++) {
        rows++;
        let l = false;
        for (let x = c.x0; x <= c.x0 + Math.max(2, Math.round(0.35 * w)); x++) if (labels[y * W + x] === c.id) l = true;
        if (l) leftRows++;
        for (let x = c.x1 - rw + 1; x <= c.x1; x++) if (labels[y * W + x] === c.id) rightInk++;
      }
      if (leftRows < 0.6 * rows) return false;
      const st = shapeStats(clean, labels, c);
      // cut time: a stroke running through the whole glyph, arcs on both sides, taller than a plain C
      if (st.maxVRunFrac >= 0.9 && h >= 2.9 * d) return true;
      // the C's left arc is a tall curve; a slash or rest only touches its left edge with a short tip
      let leftExtent = 0;
      for (let y = c.y0; y <= c.y1; y++) {
        if (labels[y * W + c.x0] === c.id || labels[y * W + Math.min(W - 1, c.x0 + 1)] === c.id) leftExtent++;
      }
      if (leftExtent < 0.85 * d) return false;
      return h <= 2.7 * d && rightInk <= 0.3 * rows * rw;
    };
    const cc = pre.find(isC);
    const fragIds: number[] = [];
    const stackX = topRow.length > 0 && botRow.length > 0 && Math.abs(topRow[0].x0 - botRow[0].x0) < 1.2 * d ? topRow[0].x0 : Infinity;
    if (cc && cc.x0 < stackX) {
      timeComps.add(cc.id);
      // The bold left arc of a plain C is itself a near-full-height vertical run, so the run alone says nothing. Cut
      // time has a separate thin stroke through the MIDDLE of the glyph that sticks out above and below the arcs
      // (total height ~3.4 d against ~2.2 d for a C): require a tall glyph and a full-height run in the central columns.
      const w = ww(cc);
      const h = hh(cc);
      let midRun = 0;
      for (let x = cc.x0 + Math.round(0.3 * w); x <= cc.x0 + Math.round(0.7 * w); x++) {
        let run = 0;
        for (let y = cc.y0; y <= cc.y1; y++) {
          if (labels[y * W + x] === cc.id) {
            run++;
            if (run > midRun) midRun = run;
          } else run = 0;
        }
      }
      timeSig = h >= 2.6 * d && midRun >= 0.85 * h ? { numerator: 2, denominator: 2 } : { numerator: 4, denominator: 4 };
    } else if (stackX === Infinity && pre.length > 0 && (() => {
      // A common-time C that staff-line removal cut into pieces (left arc + terminals): judge the cluster as a whole.
      // It must be one glyph ~1-2 d wide and ~2-2.8 d tall centred on the middle line, with a tall left arc and an
      // EMPTY middle on the right (the opening of the C); chord text / rests / noteheads fail one of these.
      // only comps lying on the staff (text / chord symbols above it can come first in x order)
      const onStaff = pre.filter((c) => c.y0 >= topL - 0.5 * d && c.y1 <= botL + 0.5 * d);
      if (onStaff.length === 0) return false;
      const g0 = onStaff[0];
      const cl = onStaff.filter((c) => c.x0 <= g0.x0 + 2.0 * d && c.x0 >= g0.x0 - 0.3 * d);
      const bx0 = Math.min(...cl.map((c) => c.x0));
      const bx1 = Math.max(...cl.map((c) => c.x1));
      const by0 = Math.min(...cl.map((c) => c.y0));
      const by1 = Math.max(...cl.map((c) => c.y1));
      const w = bx1 - bx0 + 1;
      const h = by1 - by0 + 1;
      if (cl.length < 2 || w < 0.8 * d || w > 2.2 * d || h < 1.8 * d || h > 2.9 * d) return false;
      if (Math.abs((by0 + by1) / 2 - midL) > 0.6 * d) return false;
      if (hh(g0) < 1.6 * d || ww(g0) > 1.3 * d) return false;
      // the opening of the C: right quarter of the glyph empty just above OR just below the middle line (line removal
      // can leave a stub of a terminal on the middle line itself, so the rows within 0.1 d of it are skipped)
      const openAt = (ya: number, yb: number): boolean => {
        let ink = 0;
        let tot = 0;
        for (let y = Math.round(ya); y <= Math.round(yb); y++)
          for (let x = bx1 - Math.round(0.25 * w); x <= bx1; x++) {
            tot++;
            if (clean.d[y * W + x]) ink++;
          }
        return ink <= 0.15 * tot;
      };
      if (!openAt(midL - 0.5 * d, midL - 0.12 * d) && !openAt(midL + 0.12 * d, midL + 0.5 * d)) return false;
      for (const c of cl) fragIds.push(c.id);
      return true;
    })()) {
      for (const id of fragIds) timeComps.add(id);
      timeSig = { numerator: 4, denominator: 4 };
    } else if (stackX < Infinity) {
      const read = (row: Comp[]): number => {
        let n = 0;
        for (const c of row) {
          const dg = readDigitComp(labels, W, c);
          if (dg < 0) return -1;
          n = n * 10 + dg;
        }
        return n;
      };
      const num = read(topRow);
      const den = read(botRow);
      for (const c of [...topRow, ...botRow]) timeComps.add(c.id);
      // A bold numeral sits ON the top / bottom staff line, and the general line removal eats an arc lying on a line: a "2"
      // then comes out as a closed 6 / 8 (and a "3" or "5" can lose its top bar). A hole-bearing numerator read from a piece
      // that touches an outer line is therefore not trusted: report "unreadable" so the assembler infers the meter from how
      // the bars add up instead of committing to a wrong printed one.
      const touchesLine = topRow.some((c) => c.y0 <= topL + 0.25 * d) || botRow.some((c) => c.y1 >= botL - 0.25 * d);
      const holeNumeral = num === 6 || num === 8 || num === 9 || num === 0;
      if (touchesLine && holeNumeral && topRow.length === 1) timeSigUnreadable = true;
      else if (num >= 1 && num <= 32 && [1, 2, 4, 8, 16, 32].includes(den)) timeSig = { numerator: num, denominator: den };
      else timeSigUnreadable = true;
    }
      let x1 = keyEndX;
    for (const id of timeComps) x1 = Math.max(x1, comps[id - 1].x1);
    return { timeSig, unreadable: timeSigUnreadable, x1 };
  };
  const mainTime = readTimeSig(keyEnd, keyEnd + 3.4 * d, false);
  const timeSig = mainTime.timeSig;
  const timeSigUnreadable = mainTime.unreadable;
  let prefixEnd = Math.max(clefEnd, keyEnd);
  prefixEnd = Math.max(prefixEnd, mainTime.x1);
  const musicStart = prefixEnd + 0.2 * d;
  for (const c of comps) if (c.x0 >= clefEnd - 0.3 * d && c.x1 <= prefixEnd + 0.15 * d) used.add(c.id);

  // ---- slash marks (chord comping): thick diagonal strokes, no round head
  const slashes: { cx: number; cy: number }[] = [];
  const slashIds = new Set<number>();
  {
    // a slash is ~0.4 d thick horizontally only at its steepest; take the core with a lower bar so it survives
    const hmin0 = Math.max(2, Math.round(0.25 * d));
    for (const c of comps) {
      if (used.has(c.id) || isBarline(c) || c.x0 < musicStart - 0.2 * d) continue;
      const w = ww(c);
      const h = hh(c);
      if (w < 1.0 * d || w > 3.2 * d || h < 0.9 * d || h > 4.4 * d || c.area < 0.5 * d * d) continue;
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let cx0 = Infinity;
      let cx1 = -Infinity;
      let cy0 = Infinity;
      let cy1 = -Infinity;
      for (let y = c.y0; y <= c.y1; y++)
        for (let x = c.x0; x <= c.x1; x++) {
          const i = y * W + x;
          if (labels[i] !== c.id || hrun[i] < hmin0) continue;
          n++;
          sx += x;
          sy += y;
          sxx += x * x;
          syy += y * y;
          sxy += x * y;
          if (x < cx0) cx0 = x;
          if (x > cx1) cx1 = x;
          if (y < cy0) cy0 = y;
          if (y > cy1) cy1 = y;
        }
      if (n < 0.35 * d * d) continue;
      const mx = sx / n;
      const my = sy / n;
      const vxx = sxx / n - mx * mx;
      const vyy = syy / n - my * my;
      const vxy = sxy / n - mx * my;
      const tr = vxx + vyy;
      const det = vxx * vyy - vxy * vxy;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + disc;
      const l2 = Math.max(1e-6, tr / 2 - disc);
      const elong = Math.sqrt(l1 / l2);
      const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy); // image coords (y down)
      const slope = (-theta * 180) / Math.PI; // positive = rising to the right
      const coreW = cx1 - cx0 + 1;
      const coreH = cy1 - cy0 + 1;
      if (n >= 0.86 * c.area && elong >= 2.3 && slope >= 18 && slope <= 75 && coreW >= 0.9 * d && coreW <= 3.0 * d && coreH >= 0.8 * d && coreH <= 2.6 * d && Math.abs(my - midL) <= 1.8 * d) {
        slashes.push({ cx: mx + rx0, cy: my + ry0 });
        slashIds.add(c.id);
      }
    }
  }

  // ---- multi-measure rests (thick bar on the middle line, number above)
  const multiRests: { x0: number; x1: number; count: number; guessed: boolean }[] = [];
  const mrIds = new Set<number>();
  {
    const bars = findMultiRestBars({ w: W, h: H, d: src.d }, d, t, midL, lx(staff.left), lx(staff.right)).filter((b) => b.x0 > musicStart - 0.2 * d && b.x1 - b.x0 >= 4.5 * d); // shorter thick bars are beams
    for (const b of bars) {
      // skip bars made of a beam/tie: require the bar not to be attached to noteheads (few comps overlap its row band)
      let count = 1;
      let guessed = true;
      const cxm = (b.x0 + b.x1) / 2;
      const frags = comps.filter((c) => c.y1 < topL - 0.3 * d && c.y0 > topL - 4.2 * d && hh(c) >= 0.5 * d && hh(c) <= 2.8 * d && ww(c) <= 1.9 * d && c.x0 >= b.x0 && c.x1 <= b.x1 && c.area >= 0.1 * d * d).sort((a, bb) => a.x0 - bb.x0);
      // The digit is read from the RAW crop: ledger-line removal also eats the crossbar of a 4 (a 2 px bar of one glyph
      // width above the staff looks like a ledger line), which is what made it read as a 3.
      // a bold digit often arrives in two pieces (diagonal + stem of a 4, the halves of a 5 ...): fuse fragments that
      // overlap horizontally and touch / nearly touch vertically into one glyph before reading
      type Part = { ids: Set<number>; x0: number; y0: number; x1: number; y1: number };
      const cand: Part[] = [];
      for (const c of frags) {
        const host = cand.find((p) => {
          const ov = Math.min(p.x1, c.x1) - Math.max(p.x0, c.x0) + 1;
          return ov >= 0.5 * Math.min(p.x1 - p.x0 + 1, ww(c)) && c.y0 <= p.y1 + 0.4 * d && c.y1 >= p.y0 - 0.4 * d && Math.max(p.y1, c.y1) - Math.min(p.y0, c.y0) + 1 <= 2.8 * d;
        });
        if (host) {
          host.ids.add(c.id);
          host.x0 = Math.min(host.x0, c.x0);
          host.x1 = Math.max(host.x1, c.x1);
          host.y0 = Math.min(host.y0, c.y0);
          host.y1 = Math.max(host.y1, c.y1);
        } else cand.push({ ids: new Set([c.id]), x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
      }
      cand.sort((a, bb) => Math.abs((a.x0 + a.x1) / 2 - cxm) - Math.abs((bb.x0 + bb.x1) / 2 - cxm));
      if (cand.length > 0) {
        const seed = cand[0];
        const group = [seed];
        for (const c of cand.slice(1)) {
          const near = group.some((g) => Math.abs(c.y0 - g.y0) <= 0.5 * d && (c.x0 - g.x1 <= 0.6 * d && g.x0 - c.x1 <= 0.6 * d));
          if (near && group.length < 3) group.push(c);
        }
        group.sort((a, bb) => a.x0 - bb.x0);
        let n = 0;
        let okRead = true;
        for (const c of group) {
          const w = c.x1 - c.x0 + 1;
          const h = c.y1 - c.y0 + 1;
          const g = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = src.d[(c.y0 + y) * W + c.x0 + x];
          const dg = classifyDigit(g, w, h);
          if (dg < 0) {
            okRead = false;
            break;
          }
          n = n * 10 + dg;
        }
        if (okRead && n >= 2 && n <= 99) {
          count = n;
          guessed = false;
        }
      }
      multiRests.push({ x0: b.x0 + rx0, x1: b.x1 + rx0, count, guessed });
      for (const c of comps) if (c.x0 >= b.x0 - 3 && c.x1 <= b.x1 + 3 && c.y0 <= midL && c.y1 >= midL && hh(c) <= 2.4 * d) mrIds.add(c.id);
    }
  }

  // ---- tuplet brackets ("3" in a gap of a thin bracket with end ticks)
  const tupletScan = (() => {
    // own crop that reaches further above / below the staff than the symbol crop (brackets sit 5+ spaces away and the
    // symbol crop is clipped at the midpoint to the neighbouring staff); the staff body itself is blanked
    const by0 = Math.max(0, Math.floor(Math.max(opts.limitTop ?? -Infinity, staff.top - 8.5 * d)));
    const by1 = Math.min(bin.height, Math.ceil(Math.min(opts.limitBottom ?? Infinity, staff.bottom + 8.5 * d)));
    const bc = cropBinary(bin, rx0, by0, rx1, by1);
    const none = { brackets: [] as { x0: number; x1: number; n: number; y0: number; y1: number }[], loose: [] as { cx: number; y0: number; y1: number; above: boolean }[] };
    if (bc.width < 8 || bc.height < 8) return none;
    for (let yy = Math.max(0, Math.floor(staff.top - 0.4 * d - by0)); yy <= Math.min(bc.height - 1, Math.ceil(staff.bottom + 0.4 * d - by0)); yy++) bc.data.fill(0, yy * bc.width, (yy + 1) * bc.width);
    const lc = labelComponents(bc.width, bc.height, bc.data);
    const r = findTupletBrackets(
      lc.comps,
      lc.labels,
      bc.width,
      d,
      staff.top - by0,
      staff.bottom - by0,
      musicStart,
      multiRests.map((m) => ({ x0: m.x0 - rx0, x1: m.x1 - rx0 })),
    );
    return {
      brackets: r.brackets.map((b) => ({ x0: b.x0 + rx0, x1: b.x1 + rx0, n: b.n, y0: b.y0 + by0, y1: b.y1 + by0 })),
      // digits without a bracket: local x, page y
      loose: r.loose.map((l) => ({ cx: l.cx + rx0, y0: l.y0 + by0, y1: l.y1 + by0, above: l.above })),
    };
  })();
  // brackets are handed to the staff that owns the notes under / over them by analyzePage (tupletCands)
  const tuplets: { x0: number; x1: number; n: number }[] = [];

  // ---- opened mask for filled noteheads
  const hmin = Math.max(2, Math.round(0.5 * d));
  const vmin = Math.max(2, Math.round(0.7 * d));
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = clean.d[i] && hrun[i] >= hmin && vrun[i] >= vmin ? 1 : 0;
  const { labels: mlab, comps: mcomps } = labelComponents(W, H, mask);

  interface RawHead {
    cx: number;
    cy: number;
    hollow: boolean;
    comp: number;
    conf: number;
    holeHW?: number;
    outerW?: number;
    coreArea?: number;
    coreFill?: number;
  }
  const rawHeads: RawHead[] = [];

  // hollow heads: ring detection on the ORIGINAL crop (holes survive staff-line removal there)
  const hollowBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const ringIds = new Set<number>();
  const hollowFound = findHollowHeads({ w: W, h: H, d: src.d }, d, t, (x, i) => (i < 0 ? ly(lineY(staff, 0, x + rx0) + i * d) : i > 4 ? ly(lineY(staff, 4, x + rx0) + (i - 4) * d) : ly(lineY(staff, i, x + rx0))));
  for (const hf of hollowFound) {
    if (hf.cx <= musicStart || hf.cy < topL - 4.6 * d || hf.cy > botL + 4.6 * d) continue;
    // ring components (cleaned image): mark them as note components so they are not reinterpreted as rests/ties
    const ids = new Map<number, number>();
    for (let y = Math.round(hf.cy - 0.7 * d); y <= Math.round(hf.cy + 0.7 * d); y++)
      for (let x = Math.round(hf.cx - 0.85 * d); x <= Math.round(hf.cx + 0.85 * d); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const l = labels[y * W + x];
        if (l) ids.set(l, (ids.get(l) ?? 0) + 1);
      }
    let main = 0;
    let mainN = 0;
    for (const [id, n] of ids) {
      const c = comps[id - 1];
      if (ww(c) <= 2.4 * d && n > mainN) {
        main = id;
        mainN = n;
      }
    }
    if (main === 0) {
      let bn = 0;
      for (const [id, n] of ids) if (n > bn) {
        bn = n;
        main = id;
      }
    }
    if (main && (used.has(main) || slashIds.has(main) || mrIds.has(main))) continue;
    rawHeads.push({ cx: hf.cx, cy: hf.cy, hollow: true, comp: main, conf: hf.conf, holeHW: hf.holeHW, outerW: hf.outerW });
    hollowBoxes.push({ x0: hf.cx - 0.8 * d, x1: hf.cx + 0.8 * d, y0: hf.cy - 0.6 * d, y1: hf.cy + 0.6 * d });
    for (const [id] of ids) if (ww(comps[id - 1]) <= 2.4 * d) ringIds.add(id);
  }

  // filled heads from opened cores
  for (const mc of mcomps) {
    const w = mc.x1 - mc.x0 + 1;
    const h = mc.y1 - mc.y0 + 1;
    if (mc.area < 0.4 * d * d || w < 0.82 * d || h < 0.65 * d) continue;
    if (mc.area / (w * h) < 0.45) continue;
    // find parent comp
    let comp = 0;
    for (let y = mc.y0; y <= mc.y1 && !comp; y++)
      for (let x = mc.x0; x <= mc.x1; x++)
        if (mlab[y * W + x] === mc.id) {
          comp = labels[y * W + x];
          break;
        }
    const pc = comps[comp - 1];
    if (isClefCand(pc) || used.has(pc.id) || slashIds.has(pc.id) || mrIds.has(pc.id)) continue;
    const pw = pc.x1 - pc.x0 + 1;
    const ph = pc.y1 - pc.y0 + 1;
    // quarter-rest / accidental-sized blobs without a stem are not noteheads
    if (ph > 1.7 * d && ph < 2.6 * d && pw < 1.2 * d) continue;
    // half / whole rests (a thin bar sitting on a line) are shorter than any notehead
    if (ph < 0.8 * d) continue;
    // solid rectangles (whole / half rest merged with their staff line) are not heads
    if (pw >= 0.8 * d && pw <= 2.2 * d && ph <= 1.05 * d && pc.area / (pw * ph) >= 0.88) continue;
    const pieces: { x0: number; x1: number }[] = [];
    const splitX = (xa: number, xb: number) => {
      if (xb - xa + 1 >= 2.0 * d) {
        // find the column with the fewest mask pixels near the middle
        let bestX = Math.round((xa + xb) / 2);
        let bestC = Infinity;
        const lo = Math.round(xa + 0.6 * d);
        const hi = Math.round(xb - 0.6 * d);
        for (let x = lo; x <= hi; x++) {
          let cnt = 0;
          for (let y = mc.y0; y <= mc.y1; y++) if (mlab[y * W + x] === mc.id) cnt++;
          if (cnt < bestC) {
            bestC = cnt;
            bestX = x;
          }
        }
        splitX(xa, bestX);
        splitX(bestX + 1, xb);
      } else pieces.push({ x0: xa, x1: xb });
    };
    splitX(mc.x0, mc.x1);
    for (const pcs of pieces) {
      let ymin = Infinity;
      let ymax = -Infinity;
      let xmin = Infinity;
      let xmax = -Infinity;
      for (let y = mc.y0; y <= mc.y1; y++)
        for (let x = pcs.x0; x <= pcs.x1; x++)
          if (mlab[y * W + x] === mc.id) {
            if (y < ymin) ymin = y;
            if (y > ymax) ymax = y;
            if (x < xmin) xmin = x;
            if (x > xmax) xmax = x;
          }
      if (ymin === Infinity) continue;
      const hh = ymax - ymin + 1;
      const n = Math.max(1, Math.floor(hh / (0.9 * d) + 0.25));
      const single = hh / n;
      // beams, flags and other thick strokes are taller / wider than any notehead
      if (single > 1.3 * d || single < 0.55 * d || xmax - xmin + 1 > 1.55 * d || (xmax - xmin + 1) / single > 1.5) continue;
      for (let i = 0; i < n; i++) {
        const cx = (xmin + xmax + 1) / 2;
        const cy = ymin + (i + 0.5) * single;
        let conf = 0.9;
        if (single < 0.6 * d || single > 1.25 * d) conf *= 0.7;
        if (n > 1) conf *= 0.9;
        rawHeads.push({ cx, cy, hollow: false, comp, conf, coreArea: mc.area / n, coreFill: mc.area / (w * h) });
      }
    }
  }
  // drop filled heads inside hollow boxes and heads outside plausible vertical range
  let heads0 = rawHeads.filter((r) => {
    if (!r.hollow) {
      for (const hb of hollowBoxes) if (r.cx >= hb.x0 && r.cx <= hb.x1 && r.cy >= hb.y0 && r.cy <= hb.y1) return false;
    }
    return r.cy >= topL - 4.6 * d && r.cy <= botL + 4.6 * d;
  });
  // de-duplicate nearly coincident heads
  heads0.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  const dedup: RawHead[] = [];
  for (const h of heads0) {
    if (dedup.some((o) => Math.abs(o.cx - h.cx) < 0.4 * d && Math.abs(o.cy - h.cy) < 0.4 * d)) continue;
    dedup.push(h);
  }
  heads0 = dedup;
  const noteComps = new Set<number>(heads0.map((h) => h.comp));

  // ---- other (non-note) components
  const others = comps.filter((c) => {
    if (noteComps.has(c.id) || c.area < 2 || slashIds.has(c.id) || mrIds.has(c.id)) return false;
    if (ringIds.has(c.id)) return false;
    return true;
  });
  const sortedRest = [...others].sort((a, b) => a.x0 - b.x0);

  // keep only heads after the prefix
  const heads1 = heads0.filter((h) => h.cx > musicStart);

  // ---- stems
  const attachedAt = (cx: number, xx: number, r: number): boolean => {
    const dir = xx >= cx ? 1 : -1;
    for (let x = Math.round(cx); x !== xx + dir; x += dir) if (!ink(x, r)) return false;
    return true;
  };
  const vExtent = (x: number, y: number): { top: number; bottom: number } => {
    let top = y;
    let miss = 0;
    for (let yy = y - 1; yy >= 0; yy--) {
      if (ink(x, yy)) {
        top = yy;
        miss = 0;
      } else if (++miss > 1) break;
    }
    let bottom = y;
    miss = 0;
    for (let yy = y + 1; yy < H; yy++) {
      if (ink(x, yy)) {
        bottom = yy;
        miss = 0;
      } else if (++miss > 1) break;
    }
    return { top, bottom };
  };
  const stemFor = (cx: number, cy: number, holeHW = 0): StemCand | null => {
    let best: (StemCand & { len: number }) | null = null;
    const win = Math.max(1, Math.round(0.35 * d));
    const cols: { x: number; top: number; bottom: number; len: number }[] = [];
    for (const side of [1, -1]) {
      for (let off = Math.round(0.4 * d); off <= Math.round(0.95 * d); off++) {
        const xx = Math.round(cx + side * off);
        let bl = 0;
        let bt = 0;
        let bb = 0;
        for (let r = Math.round(cy) - win; r <= Math.round(cy) + win; r++) {
          if (!ink(xx, r) || !attachedAt(holeHW > 0 ? cx + side * (holeHW + 1) : cx, xx, r)) continue;
          const e = vExtent(xx, r);
          const len = e.bottom - e.top + 1;
          if (len > bl) {
            bl = len;
            bt = e.top;
            bb = e.bottom;
          }
        }
        if (bl > 0) cols.push({ x: xx, top: bt, bottom: bb, len: bl });
      }
    }
    for (const c of cols) if (!best || c.len > best.len) best = c;
    if (!best || best.len < 2.2 * d) return null;
    if (Math.max(cy - best.top, best.bottom - cy) < 1.7 * d) return null;
    const same = cols.filter((c) => c.len >= 0.9 * best!.len && Math.abs(c.x - best!.x) <= Math.ceil(2 * t + 1));
    const x = same.reduce((s, c) => s + c.x, 0) / same.length;
    return { x: x + 0.5, top: best.top, bottom: best.bottom };
  };

  const stems: StemInfo[] = [];
  const headStem: number[] = [];
  const stemHeads: number[][] = [];
  heads1.forEach((h) => {
    const sc = stemFor(h.cx, h.cy, h.hollow ? (h.holeHW ?? 0) : 0);
    if (!sc) {
      headStem.push(-1);
      return;
    }
    let sid = stems.findIndex((s) => Math.abs(s.x - sc.x) <= 0.35 * d && sc.top <= s.bottom && sc.bottom >= s.top);
    if (sid < 0) {
      sid = stems.length;
      stems.push({ id: sid, x: sc.x, top: sc.top, bottom: sc.bottom, up: true, flags: 0, beamed: false });
      stemHeads.push([]);
    } else {
      const s = stems[sid];
      s.top = Math.min(s.top, sc.top);
      s.bottom = Math.max(s.bottom, sc.bottom);
    }
    stemHeads[sid].push(headStem.length);
    headStem.push(sid);
  });

  // Drop stemless filled "heads" that are really flag blobs hanging off a stem tip
  const dropHead = new Set<number>();
  heads1.forEach((h, i) => {
    if (h.hollow || headStem[i] >= 0) return;
    // a stemless filled blob that is small or too solid is a beam / flag / accent fragment, not a notehead
    if ((h.coreArea ?? Infinity) < 0.95 * d * d || (h.coreFill ?? 0) > 0.92) {
      dropHead.add(i);
      return;
    }
    for (const s of stems) {
      const sheads = stemHeads[s.id].map((hi) => heads1[hi].cy);
      const tipUp = Math.min(...sheads) - s.top >= s.bottom - Math.max(...sheads);
      const tipY = tipUp ? s.top : s.bottom;
      if (h.cx - s.x > -0.3 * d && h.cx - s.x < 1.6 * d && Math.abs(h.cy - tipY) <= 1.3 * d) {
        dropHead.add(i);
        break;
      }
    }
  });

  // a hollow "head" on the stem of filled heads is a flag loop, not a notehead
  heads1.forEach((h, i) => {
    if (!h.hollow || headStem[i] < 0) return;
    const sid = headStem[i];
    const filled = stemHeads[sid].filter((hi) => !heads1[hi].hollow);
    if (filled.length === 0) return;
    const dy = Math.min(...filled.map((hi) => Math.abs(heads1[hi].cy - h.cy)));
    if (dy > 1.2 * d) dropHead.add(i);
  });

  const rescued = new Set<number>();
  // a short stem cannot carry two heads far apart: the smaller blob is the beam / flag end, not a notehead
  stems.forEach((st, sid) => {
    const hs = stemHeads[sid].filter((hi) => !dropHead.has(hi));
    if (hs.length < 2 || (st.bottom - st.top) / d >= 4.8) return;
    for (let a = 0; a < hs.length; a++)
      for (let b = a + 1; b < hs.length; b++) {
        const ha = heads1[hs[a]];
        const hb = heads1[hs[b]];
        if (ha.hollow || hb.hollow || dropHead.has(hs[a]) || dropHead.has(hs[b])) continue;
        if (Math.abs(ha.cy - hb.cy) <= 2.0 * d) continue;
        dropHead.add((ha.coreArea ?? 0) < (hb.coreArea ?? 0) ? hs[a] : hs[b]);
      }
  });
  // a stemless hollow ring narrower than a whole note is a loop of a rest / accidental
  heads1.forEach((h, i) => {
    if (!h.hollow || headStem[i] >= 0) return;
    const pc = h.comp > 0 ? comps[h.comp - 1] : undefined;
    // narrow rings, or rings that are part of a tall glyph (quarter-rest zig-zag), are not whole notes
    const tall = !!pc && pc.y1 - pc.y0 + 1 > 1.9 * d;
    if ((h.outerW ?? Infinity) < 1.3 * d || tall) {
      dropHead.add(i);
      if (tall) rescued.add(h.comp);
    }
  });
  // a hollow "head" in the middle of a long stroke (a flat sign's loop) has stem on both sides; a real head sits at a stem end
  heads1.forEach((h, i) => {
    if (!h.hollow || headStem[i] < 0 || stemHeads[headStem[i]].length > 1) return;
    const st = stems[headStem[i]];
    if (h.cy - st.top >= 1.0 * d && st.bottom - h.cy >= 1.0 * d) dropHead.add(i);
  });

  // stem direction, flags and beams
  const stemLabelOf = (s: StemInfo): number => {
    const x = Math.round(s.x - 0.5);
    const y = Math.round((s.top + s.bottom) / 2);
    for (let dx = -1; dx <= 1; dx++) if (ink(x + dx, y)) return labels[y * W + x + dx];
    return 0;
  };
  const stemsPerLabel = new Map<number, number>();
  for (const s of stems) {
    const l = stemLabelOf(s);
    stemsPerLabel.set(l, (stemsPerLabel.get(l) ?? 0) + 1);
  }
  stems.forEach((s, sid) => {
    const ys = stemHeads[sid].map((hi) => heads1[hi].cy);
    const dTop = Math.min(...ys) - s.top;
    const dBot = s.bottom - Math.max(...ys);
    s.up = dTop >= dBot;
    const len = s.bottom - s.top;
    const zone = Math.min(2.6 * d, len - 1.3 * d);
    const lab = stemLabelOf(s);
    let best = 0;
    if (zone >= 0.5 * d) {
      const ya = s.up ? Math.round(s.top - 1) : Math.round(s.bottom - zone);
      const yb = s.up ? Math.round(s.top + zone) : Math.round(s.bottom + 1);
      const maxRun = Math.round(2.4 * d);
      const beamB = 0.45 * d;
      const beamG = 0.25 * d;
      // a run may be several beams fused together (or with a staff line): estimate how many
      const beamsIn = (run: number): number => (run <= 1.5 * beamB + 1 ? 1 : Math.max(1, Math.round((run + beamG) / (beamB + beamG))));
      // count ink runs of the stem's own component in several columns beside the stem tip; the median over the columns
      // is robust against ties / noise, and each stem is measured at its own x (partial beams)
      const minRun1 = Math.max(3, Math.round(0.26 * d));
      const solo = (stemsPerLabel.get(lab) ?? 1) <= 1;
      const unitCount = (run: number): number => (solo ? (run <= 1.7 * d ? 1 : 2) : beamsIn(run));
      const offs: number[] = [];
      for (let o = Math.round(0.3 * d); o <= Math.round(0.9 * d); o++) offs.push(o);
      for (const side of [1, -1]) {
        const counts: number[] = [];
        for (const off of offs) {
          const x = Math.round(s.x - 0.5 + side * off);
          let cnt = 0;
          let run = 0;
          for (let y = ya; y <= yb + 1; y++) {
            const at = (yy: number): boolean => yy <= yb && yy >= 0 && yy < H && x >= 0 && x < W && lab !== 0 && labels[yy * W + x] === lab;
            // a one pixel hole (anti-aliasing, staff-line residue) does not split a stroke
            const inLab = at(y) || (run > 0 && at(y + 1) && at(y - 1));
            if (inLab) run++;
            else {
              if (run >= minRun1 && run <= maxRun) {
                // a beam crossing a staff line keeps a few rows of the line: discount them
                let eff = run;
                const r0 = y - run;
                const r1 = y - 1;
                for (let li = 0; li < 5; li++) {
                  const c = ly(lineY(staff, li, x + rx0));
                  if (c >= r0 - 1 && c <= r1 + 1) {
                    eff = Math.max(Math.min(run, beamB), run - (t + 1));
                    break;
                  }
                }
                let onLine = eff < minRun1;
                // a thin run centred on a staff line is line residue clinging to the stem
                if (!onLine && run <= t + 1.5)
                  for (let li = 0; li < 5; li++) if (Math.abs(ly(lineY(staff, li, x + rx0)) - (y - run / 2)) <= t / 2 + 1.5) onLine = true;
                if (!onLine) cnt += unitCount(eff);
              }
              run = 0;
            }
          }
          counts.push(cnt);
        }
                const nz = counts.filter((c) => c > 0).sort((p, q) => p - q);
        if (nz.length >= Math.max(2, 0.4 * counts.length)) best = Math.max(best, nz[Math.floor(nz.length / 2)]);
      }
    }
    s.flags = Math.min(3, best);
  });
  // beamed: stems sharing the same CC
  {
    const byLabel = new Map<number, number>();
    for (const s of stems) {
      const l = stemLabelOf(s);
      byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
    }
    for (const s of stems) s.beamed = s.flags > 0 && (byLabel.get(stemLabelOf(s)) ?? 0) > 1;
  }

  // ---- build notehead objects (page coordinates)
  const noteheads0: Notehead[] = heads1.map((h, i) => {
    let conf = h.conf;
    const sid = headStem[i];
    if (sid < 0 && !h.hollow) conf *= 0.65;
    return {
      cx: h.cx + rx0,
      cy: h.cy + ry0,
      x0: h.cx + rx0 - 0.65 * d,
      x1: h.cx + rx0 + 0.65 * d,
      y0: h.cy + ry0 - 0.5 * d,
      y1: h.cy + ry0 + 0.5 * d,
      hollow: h.hollow,
      stemId: sid,
      dots: 0,
      tiedFromPrevious: false,
      confidence: conf,
      step: 0,
    };
  });
  const noteheads = noteheads0.filter((_, i) => !dropHead.has(i));
  const pageStems: StemInfo[] = stems.map((s) => ({ ...s, x: s.x + rx0, top: s.top + ry0, bottom: s.bottom + ry0 }));
  // a "3" sitting just beyond the beam of three beamed stems (no bracket): an eighth / sixteenth triplet
  for (const g of tupletScan.loose) {
    const cand = pageStems.filter((s) => s.beamed && Math.abs(s.x - g.cx) <= 3.6 * d && (g.above ? s.up && g.y1 >= s.top - 1.6 * d && g.y1 <= s.top + 0.3 * d : !s.up && g.y0 >= s.bottom - 0.3 * d && g.y0 <= s.bottom + 1.6 * d));
    if (cand.length < 3) continue;
    cand.sort((a, b) => Math.abs(a.x - g.cx) - Math.abs(b.x - g.cx));
    const trio = cand.slice(0, 3).sort((a, b) => a.x - b.x);
    if (g.cx < trio[0].x - 0.8 * d || g.cx > trio[2].x + 0.8 * d) continue;
    // the three stems must be consecutive in their beam group (no other stem between them)
    const between = pageStems.filter((s) => s.beamed && s.x > trio[0].x + 0.5 * d && s.x < trio[2].x - 0.5 * d);
    if (between.length !== 1) continue;
    tuplets.push({ x0: trio[0].x - 0.9 * d, x1: trio[2].x + 0.9 * d, n: 3 });
  }

  // ---- remaining symbols: dots, accidentals, rests, ties
  const rests: RestSym[] = [];
  const accs: { kind: AccidentalKind; comp: Comp; conf: number }[] = [];
  const dotsC: Comp[] = [];
  const ties: Comp[] = [];
  const noteheadsUseComp = (id: number): boolean => heads1.some((h, i) => !dropHead.has(i) && h.comp === id);
  const restBlobs0 = [...sortedRest, ...comps.filter((c) => rescued.has(c.id) && !noteheadsUseComp(c.id))]
    .sort((a, b) => a.x0 - b.x0)
    .filter((c) => !used.has(c.id) && c.x0 >= clefEnd - 1 && c.x1 > musicStart - 0.2 * d);
  // staff-line removal can cut a rest in two across a line: re-join fragments stacked on a line row
  const frag = new Set<number>();
  const restBlobs: Comp[] = [];
  {
    const taken0 = new Set<number>();
    for (let i = 0; i < restBlobs0.length; i++) {
      const a = restBlobs0[i];
      if (taken0.has(a.id)) continue;
      let cur: Comp = a;
      for (let j = i + 1; j < restBlobs0.length; j++) {
        const b = restBlobs0[j];
        if (taken0.has(b.id)) continue;
        if (b.x0 > cur.x1 + 2) break;
        const top = b.y0 >= cur.y0 ? cur : b;
        const bot = b.y0 >= cur.y0 ? b : cur;
        const gap = bot.y0 - top.y1 - 1;
        if (gap < -3 || gap > t + 3) continue;
        const ov = Math.min(cur.x1, b.x1) - Math.max(cur.x0, b.x0) + 1;
        if (ov < -2) continue;
        const gy = (top.y1 + bot.y0) / 2;
        let onLine = false;
        for (let li = 0; li < 5; li++) if (Math.abs(ly(lineY(staff, li, (cur.x0 + cur.x1) / 2 + rx0)) - gy) <= (t + 3) / 2 + 1) onLine = true;
        if (!onLine) continue;
        const mergedC: Comp = {
          id: cur.id,
          x0: Math.min(cur.x0, b.x0),
          x1: Math.max(cur.x1, b.x1),
          y0: Math.min(cur.y0, b.y0),
          y1: Math.max(cur.y1, b.y1),
          area: cur.area + b.area + Math.max(0, gap) * Math.max(1, ov),
        };
        taken0.add(b.id);
        cur = mergedC;
        frag.add(cur.id);
      }
      restBlobs.push(cur);
    }
  }
      for (const c of restBlobs) {
    const w = ww(c);
    const h = hh(c);
    const fill = c.area / (w * h);
    const cyc = half(c);
    const roundDot = w <= 0.7 * d && h <= 0.7 * d && Math.abs(w - h) <= 0.35 * d;
    // a dot sitting on a staff line keeps a few rows of the line after removal and comes out taller than wide
    const lineDot = w <= 0.6 * d && h <= 0.95 * d && h > 0.7 * d && fill >= 0.55 && c.area >= 0.2 * d * d;
    if ((roundDot || lineDot) && w >= 0.15 * d && h >= 0.15 * d && fill >= 0.5) {
      dotsC.push(c);
      continue;
    }
    if (w >= 1.2 * d && h <= 1.4 * d && fill <= 0.65 && h >= 0.2 * d) {
      ties.push(c);
      continue;
    }
    const acc = frag.has(c.id) ? null : classifyAccidental(shapeStats(clean, labels, c), d, t);
    if (acc) {
      accs.push({ kind: acc.kind, comp: c, conf: acc.conf });
      continue;
    }
    if (cyc < topL - 0.3 * d || cyc > botL + 0.3 * d) continue;
    if (w >= 0.7 * d && w <= 2.1 * d && h <= 1.0 * d && fill >= 0.7) {
      const dTop = Math.abs(c.y0 - ly(lines[1]));
      const dBot = Math.abs(c.y1 - ly(lines[2]));
      if (Math.min(dTop, dBot) <= 0.45 * d) {
        const kind: RestKind = dTop < dBot ? 'whole' : 'half';
        rests.push({ kind, x0: c.x0 + rx0, x1: c.x1 + rx0, y0: c.y0 + ry0, y1: c.y1 + ry0, dots: 0 });
      }
      continue;
    }
    // a narrow tall curve (parenthesis around a courtesy accidental, stray bracket) is no rest
    // (a real quarter rest is just as narrow and tall, but a solid zigzag: >= 0.3 d of ink per row on average, whereas a
    // parenthesis / bracket stroke is only ~0.2 d thick)
    if (w < 1.1 * d && h >= 2.4 * d && c.area / h < 0.3 * d) continue;
    // thin vertical bits (the stems of a natural sign, a dynamic hairpin end) are never a rest
    if (w < 0.5 * d) continue;
    if (w <= 2.2 * d && h >= 1.2 * d && h <= 3.7 * d && (h >= 2.55 * d || w <= 1.7 * d)) {
      // quarter rest: ~3 d tall zigzag, mass all the way down (curl at the bottom). Eighth rest: ~1.8-2.1 d, a round
      // blob at the top and a thin diagonal stem below, so the lower half is only ~0.15 d of ink per row. The height
      // alone is not enough: line removal shortens a quarter rest to ~2.2 d, hence the lower-half test.
      let low = 0;
      let lowRows = 0;
      for (let y = Math.ceil(c.y0 + 0.5 * h); y <= c.y1; y++) {
        lowRows++;
        for (let x = c.x0; x <= c.x1; x++) if (clean.d[y * W + x]) low++;
      }
      const lowAvg = lowRows ? low / lowRows / d : 0;
      const kind: RestKind = h >= 2.55 * d || (h >= 2.1 * d && lowAvg >= 0.28) ? 'quarter' : 'eighth';
      rests.push({ kind, x0: c.x0 + rx0, x1: c.x1 + rx0, y0: c.y0 + ry0, y1: c.y1 + ry0, dots: 0 });
    }
  }

  // accidentals → heads
  const taken = new Set<number>();
  accs.sort((a, b) => b.comp.x1 - a.comp.x1);
  for (const a of accs) {
    const ref = a.kind === 'flat' ? a.comp.y1 - 0.4 * d : half(a.comp);
    let bi = -1;
    let bc = Infinity;
    noteheads.forEach((nh, i) => {
      if (taken.has(i)) return;
      const gap = nh.cx - rx0 - 0.65 * d - a.comp.x1;
      if (gap < -0.3 * d || gap > 2.4 * d) return;
      const dy = Math.abs(nh.cy - ry0 - ref);
      if (dy > 0.75 * d) return;
      const cost = dy + 0.25 * Math.max(0, gap);
      if (cost < bc) {
        bc = cost;
        bi = i;
      }
    });
    if (bi >= 0) {
      taken.add(bi);
      noteheads[bi].accidental = a.kind;
      noteheads[bi].confidence *= a.conf >= 0.8 ? 1 : 0.9;
    }
  }
  // accidentals from vertical strokes (robust against signs merged with beams / stems / parentheses)
  {
    const hits = detectAccidentals(
      { w: W, h: H, d: clean.d },
      d,
      t,
      noteheads,
      rx0,
      ry0,
      [...stems.map((s) => s.x), ...barLocal],
      musicStart + rx0,
    );
    hits.forEach((hit, i) => {
      noteheads[i].accidental = hit.kind;
    });
  }
  // dots → nearest head (or rest)
  for (const c of dotsC) {
    const cx = (c.x0 + c.x1 + 1) / 2;
    const cy = (c.y0 + c.y1 + 1) / 2;
    let bi = -1;
    let bc = Infinity;
    noteheads.forEach((nh, i) => {
      const dx = cx - (nh.cx - rx0);
      const dy = cy - (nh.cy - ry0);
      if (dx < 0.6 * d || dx > 1.9 * d || Math.abs(dy) > 0.8 * d) return;
      const cost = dx + 2 * Math.abs(dy);
      if (cost < bc) {
        bc = cost;
        bi = i;
      }
    });
    if (bi >= 0) {
      noteheads[bi].dots++;
      continue;
    }
    for (const r of rests) {
      const dx = cx - (r.x1 - rx0);
      if (dx >= -0.1 * d && dx <= 1.2 * d && cy >= r.y0 - ry0 - 0.5 * d && cy <= r.y1 - ry0 + 0.5 * d) {
        r.dots++;
        break;
      }
    }
  }
  // ties between equal-pitch heads (arcs traced beside each head; see ties.ts)
  let tieOut: Notehead | undefined;
  const tieOuts: Notehead[] = [];
  void ties; // thin horizontal arcs are classified by detectTies below
  {
    const tr = detectTies({ w: W, h: H, d: src.d }, staff, noteheads, rx0, ry0);
    for (const [, b] of tr.pairs) if (!noteheads[b].accidental) noteheads[b].tiedFromPrevious = true;
    if (tr.out.length) {
      tieOuts.push(...tr.out.map((i) => noteheads[i]));
      tieOut = tieOut ?? noteheads[tr.out[0]];
    }
  }

  // ---- barlines (merge double / final bars)
  const mergedBars: number[] = [];
  const doubledBar: boolean[] = [];
  for (const x of barLocal.map((v) => v + rx0).filter((v) => v > musicStart + rx0).sort((a, b) => a - b)) {
    if (mergedBars.length && x - mergedBars[mergedBars.length - 1] < 1.3 * d) {
      mergedBars[mergedBars.length - 1] = x;
      doubledBar[doubledBar.length - 1] = true;
    } else {
      mergedBars.push(x);
      doubledBar.push(false);
    }
  }
  const barX = mergedBars;

  // ---- courtesy key / time signatures after a double barline (mid staff) or after the last barline of the staff
  const signatureChanges: NonNullable<StaffSymbols['signatureChanges']> = [];
  barX.forEach((bx, k) => {
    const last = k === barX.length - 1;
    if (!last && !doubledBar[k]) return;
    const xb = bx - rx0;
    const winEnd = last ? lx(staff.right) - 0.2 * d : barX[k + 1] - rx0 - 0.5 * d;
    const start = xb + 0.5 * d;
    if (winEnd - start < 1.5 * d) return;
    // key: naturals (cancelling the old key => C major) are tried FIRST, as offset stroke pairs: readKeySignature would
    // take a pair of nearly level verticals for a sharp. Then flats / sharps by their stems.
    let fifths: number | undefined;
    let keyEndX = start;
    {
      const strokes = findStrokes(gImg, Math.round(start), Math.round(Math.min(winEnd, start + 5 * d)), Math.round(topL - 0.8 * d), Math.round(botL + 0.8 * d), Math.round(1.3 * d), Math.max(3, Math.round(0.42 * d)));
      let n = 0;
      let endN = start;
      for (let i = 0; i + 1 < strokes.length; ) {
        const a = strokes[i];
        const b = strokes[i + 1];
        // natural: right stroke hangs 0.45..1.3 d lower than the left one, 0.18..0.95 d apart (a sharp's strokes are level)
        const dBot = b.bot - a.bot;
        if (b.x0 - a.x1 >= 0.18 * d && b.x0 - a.x1 <= 0.95 * d && dBot >= 0.45 * d && dBot <= 1.3 * d && (n === 0 || a.x0 - endN <= 1.4 * d)) {
          n++;
          endN = b.x1;
          i += 2;
        } else if (n > 0) break;
        else i++;
      }
      if (n > 0) {
        fifths = 0;
        keyEndX = endN;
      }
    }
    if (fifths === undefined) {
      const kr = readKeySignature(gImg, d, topL, botL, start);
      if (kr.fifths !== 0 && kr.endX <= winEnd) {
        fifths = kr.fifths;
        keyEndX = kr.endX;
      }
    }
    const tr = readTimeSig(keyEndX, Math.min(winEnd, keyEndX + 3.4 * d), true);
    if (fifths === undefined && !tr.timeSig) return;
    let x1 = keyEndX;
    x1 = Math.max(x1, tr.x1);
    // x0 starts right behind the barline (a flat's bulb can sit left of the first stem the key reader found)
    const sc: (typeof signatureChanges)[number] = { barline: k, x0: bx + 0.2 * d, x1: x1 + rx0 };
    if (fifths !== undefined) sc.keyFifths = fifths;
    if (tr.timeSig) sc.timeSig = tr.timeSig;
    signatureChanges.push(sc);
  });
  if (signatureChanges.length) {
    // glyph fragments of the courtesy signature (flat bulbs, digit bowls) are not noteheads
    const inSig = (x: number) => signatureChanges.some((c) => x >= c.x0 - 0.3 * d && x <= c.x1 + 0.3 * d);
    for (let i = noteheads.length - 1; i >= 0; i--) if (inSig(noteheads[i].cx)) noteheads.splice(i, 1);
    for (let i = rests.length - 1; i >= 0; i--) if (inSig((rests[i].x0 + rests[i].x1) / 2)) rests.splice(i, 1);
  }

  // positions of rests must be after the prefix
  const restsAfter = rests.filter((r) => r.x0 > musicStart + rx0 - 0.1 * d);
  noteheads.sort((a, b) => a.cx - b.cx);
  // remap stem ids after sorting is unnecessary: stemId indexes pageStems directly (unchanged by sort)

  return {
    clef,
    clefDetected,
    keyFifths,
    timeSig,
    musicStart: musicStart + rx0,
    heads: noteheads,
    stems: pageStems,
    rests: restsAfter,
    barlines: barX,
    warnings,
    staffRight: staff.right,
    clefMissing,
    timeSigUnreadable,
    slashes,
    multiRests,
    tuplets,
    tupletCands: tupletScan.brackets,
    tieOut,
    tieOuts,
    signatureChanges: signatureChanges.length ? signatureChanges : undefined,
  };
}
