import type { AccidentalKind, Binary, ClefKind, Notehead, RestKind, RestSym, Staff, StaffSymbols, StemInfo } from './types';
import { lineY, removeStaffLines } from './staves';

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
  if (holes.length >= 2) return 8;
  if (holes.length === 1) {
    const hc = (holes[0].y0 + holes[0].y1) / 2 / h;
    if (maxCol >= 0.85 && maxColX > 0.5 * w) return 4;
    if (hc >= 0.5) return 6;
    return 9;
  }
  // no holes
  if (w < 0.4 * h && maxCol > 0.8) return 1;
  if (maxCol >= 0.85 && maxColX > 0.55 * w && botRun < 0.5) return 4; // open-top 4
  if (botRun >= 0.8 && topRun < 0.9) return 2;
  if (topRun >= 0.85 && botRun < 0.4) return 7;
  if (topRun >= 0.85) return 5;
  if (botRun < 0.8) return 3;
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------

export interface AnalyzeOptions {
  defaultClef: ClefKind;
  /** y-extents (page coords) this staff owns (clipped against neighbouring staves) */
  y0: number;
  y1: number;
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
  const sortedAll = comps.filter((c) => !isBarline(c) && c.area >= 0.1 * d * d).sort((a, b) => a.x0 - b.x0);
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

  // ---- opened mask for filled noteheads
  const hrun = runLengths(W, H, clean.d, false);
  const vrun = runLengths(W, H, clean.d, true);
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
  }
  const rawHeads: RawHead[] = [];

  // hollow heads from holes
  const hollowBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const c of comps) {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    if (w < 1.0 * d || h < 0.8 * d || c.area < 0.5 * d * d || w * h > 60 * d * d) continue;
    if (isBarline(c) || isClefCand(c)) continue;
    // digit-like blobs (time signature) never contain noteheads
    if (h >= 1.4 * d && h <= 2.6 * d && w <= 1.7 * d) continue;
    const cacc = classifyAccidental(shapeStats(clean, labels, c), d, t);
    if (cacc && (cacc.kind === 'sharp' || cacc.kind === 'natural')) continue;
    const holes = findHoles(W, labels, c);
    for (const hl of holes) {
      const hw = hl.x1 - hl.x0 + 1;
      const hh = hl.y1 - hl.y0 + 1;
      if (hw < 0.25 * d || hh < 0.2 * d || hw > 1.1 * d || hh > 0.9 * d) continue;
      if (hl.area / (hw * hh) < 0.55) continue;
      const hcx = Math.round((hl.x0 + hl.x1) / 2);
      const hcy = Math.round((hl.y0 + hl.y1) / 2);
      const cap = Math.round(0.7 * d);
      let lw = 0;
      while (lw < cap && ink(hl.x0 - 1 - lw, hcy)) lw++;
      let rw = 0;
      while (rw < cap && ink(hl.x1 + 1 + rw, hcy)) rw++;
      const ringW = lw + hw + rw;
      if (ringW < 0.95 * d || ringW > 2.1 * d) continue;
      let uh = 0;
      while (uh < cap && ink(hcx, hl.y0 - 1 - uh)) uh++;
      let dh = 0;
      while (dh < cap && ink(hcx, hl.y1 + 1 + dh)) dh++;
      const ringH = uh + hh + dh;
      if (ringH < 0.75 * d || ringH > 1.6 * d) continue;
      const cx = (hl.x0 + hl.x1 + 1) / 2;
      const cy = (hl.y0 + hl.y1 + 1) / 2;
      rawHeads.push({ cx, cy, hollow: true, comp: c.id, conf: 0.8 });
      hollowBoxes.push({ x0: cx - 0.8 * d, x1: cx + 0.8 * d, y0: cy - 0.6 * d, y1: cy + 0.6 * d });
    }
  }

  // filled heads from opened cores
  for (const mc of mcomps) {
    const w = mc.x1 - mc.x0 + 1;
    const h = mc.y1 - mc.y0 + 1;
    if (mc.area < 0.3 * d * d || w < 0.45 * d || h < 0.5 * d) continue;
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
    if (isClefCand(pc)) continue;
    const pw = pc.x1 - pc.x0 + 1;
    const ph = pc.y1 - pc.y0 + 1;
    // quarter-rest / accidental-sized blobs without a stem are not noteheads
    if (ph > 1.7 * d && ph < 2.6 * d && pw < 1.2 * d) continue;
    // half / whole rests (a thin bar sitting on a line) are shorter than any notehead
    if (ph < 0.8 * d) continue;
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
      for (let i = 0; i < n; i++) {
        const cx = (xmin + xmax + 1) / 2;
        const cy = ymin + (i + 0.5) * single;
        let conf = 0.9;
        if (single < 0.6 * d || single > 1.25 * d) conf *= 0.7;
        if (n > 1) conf *= 0.9;
        rawHeads.push({ cx, cy, hollow: false, comp, conf });
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
  const others = comps.filter((c) => !noteComps.has(c.id) && c.area >= 2);
  const rest0 = others;

  // ---- clef
  let clef: ClefKind = staff.lowerOfGrand ? 'bass' : opts.defaultClef;
  let clefDetected = false;
  let clefEnd = lx(staff.left);
  const sortedRest = [...rest0].sort((a, b) => a.x0 - b.x0);
  const used = new Set<number>();
  if (zone) {
    for (const id of zone.ids) used.add(id);
    clefEnd = zone.x1;
    const zh = zone.y1 - zone.y0 + 1;
    const spans = zone.y0 < topL - 0.5 * d && zone.y1 > botL + 0.5 * d;
    if (zh >= 5 * d || spans) {
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
      if (dots.length >= 2) {
        clef = 'bass';
        clefDetected = true;
        for (const dd of dots) {
          used.add(dd.id);
          clefEnd = Math.max(clefEnd, dd.x1);
        }
      } else if (staff.lowerOfGrand) {
        clef = 'bass';
        clefDetected = true;
      } else {
        warnings.push('Unrecognized clef (neither treble nor bass); assumed ' + clef + '.');
      }
    }
  } else {
    warnings.push('No clef found on a staff; assumed ' + clef + '.');
  }

  // ---- key & time signature (between clef and first note)
  const firstHeadX = heads0.filter((h) => h.cx > clefEnd + 0.3 * d).reduce((m, h) => Math.min(m, h.cx - 0.65 * d), Infinity);
  const pre = sortedRest.filter((c) => !used.has(c.id) && c.x0 >= clefEnd - 0.2 * d && c.x1 <= firstHeadX + 0.1 * d);
  const half = (c: Comp) => (c.y0 + c.y1) / 2;
  const hh = (c: Comp) => c.y1 - c.y0 + 1;
  const ww = (c: Comp) => c.x1 - c.x0 + 1;
  // stacked pairs → time signature digits
  const digitLike = (c: Comp) =>
    hh(c) >= 1.2 * d && hh(c) <= 2.6 * d && ww(c) <= 1.9 * d && c.y0 >= topL - 0.4 * d && c.y1 <= botL + 0.4 * d &&
    (c.y1 <= midL + 0.5 * d || c.y0 >= midL - 0.5 * d);
  const digits = pre.filter(digitLike);
  let timeSig: { numerator: number; denominator: number } | undefined;
  const timeComps = new Set<number>();
  const topRow = digits.filter((c) => half(c) < midL).sort((a, b) => a.x0 - b.x0);
  const botRow = digits.filter((c) => half(c) >= midL).sort((a, b) => a.x0 - b.x0);
  if (topRow.length > 0 && botRow.length > 0 && Math.abs(topRow[0].x0 - botRow[0].x0) < 1.2 * d) {
    const read = (row: Comp[]): number => {
      let n = 0;
      for (const c of row) {
        const w = ww(c);
        const h = hh(c);
        const g = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) g[y * w + x] = labels[(c.y0 + y) * W + c.x0 + x] === c.id ? 1 : 0;
        const dg = classifyDigit(g, w, h);
        if (dg < 0) return -1;
        n = n * 10 + dg;
      }
      return n;
    };
    const num = read(topRow);
    const den = read(botRow);
    for (const c of [...topRow, ...botRow]) timeComps.add(c.id);
    if (num >= 1 && num <= 32 && [1, 2, 4, 8, 16, 32].includes(den)) timeSig = { numerator: num, denominator: den };
    else warnings.push('Time signature could not be read; assumed 4/4.');
  } else {
    // common / cut time
    const cc = pre.find((c) => hh(c) >= 1.6 * d && hh(c) <= 2.8 * d && ww(c) >= 1.2 * d && ww(c) <= 2.2 * d && c.y0 < ly(lines[1]) + 0.3 * d && c.y1 > ly(lines[3]) - 0.3 * d);
    if (cc) {
      timeComps.add(cc.id);
      const st = shapeStats(clean, labels, cc);
      timeSig = st.maxVRunFrac >= 0.95 ? { numerator: 2, denominator: 2 } : { numerator: 4, denominator: 4 };
    }
  }

  // key signature: accidentals before the time signature / first note
  let keyCount = 0;
  let sharps = 0;
  let flats = 0;
  let lastX = clefEnd;
  const keyComps: Comp[] = [];
  const keyCands = pre.filter((c) => !timeComps.has(c.id)).sort((a, b) => a.x0 - b.x0);
  const limitX = timeComps.size
    ? Math.min(...[...timeComps].map((id) => comps[id - 1].x0))
    : Infinity;
  for (const c of keyCands) {
    if (c.x0 >= limitX) break;
    if (c.x0 - lastX > (keyCount === 0 ? 3.2 * d : 1.8 * d)) break;
    const a = classifyAccidental(shapeStats(clean, labels, c), d, t);
    if (!a) break;
    keyComps.push(c);
    keyCount++;
    if (a.kind === 'sharp') sharps++;
    else if (a.kind === 'flat') flats++;
    lastX = c.x1;
  }
  // The last accidental may belong to the first note instead (e.g. a lone sharp right before a head)
  if (keyComps.length > 0) {
    const last = keyComps[keyComps.length - 1];
    const nextHead = heads0.filter((h) => h.cx - 0.65 * d > last.x1 - 0.2 * d).sort((a, b) => a.cx - b.cx)[0];
    if (nextHead && !timeSig && nextHead.cx - 0.65 * d - last.x1 <= 0.9 * d) {
      const a = classifyAccidental(shapeStats(clean, labels, last), d, t);
      const ref = a?.kind === 'flat' ? last.y1 - 0.4 * d : half(last);
      if (Math.abs(nextHead.cy - ref) <= 0.7 * d) {
        keyComps.pop();
        keyCount--;
        if (a?.kind === 'sharp') sharps--;
        else if (a?.kind === 'flat') flats--;
      }
    }
  }
  const keyFifths = Math.max(-7, Math.min(7, sharps >= flats ? sharps : -flats));
  for (const c of keyComps) used.add(c.id);
  for (const id of timeComps) used.add(id);
  let musicStart = clefEnd;
  for (const c of keyComps) musicStart = Math.max(musicStart, c.x1);
  for (const id of timeComps) musicStart = Math.max(musicStart, comps[id - 1].x1);
  musicStart += 0.2 * d;

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
  const stemFor = (cx: number, cy: number): StemCand | null => {
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
          if (!ink(xx, r) || !attachedAt(cx, xx, r)) continue;
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
    const sc = stemFor(h.cx, h.cy);
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

  // stem direction, flags and beams
  const stemLabelOf = (s: StemInfo): number => {
    const x = Math.round(s.x - 0.5);
    const y = Math.round((s.top + s.bottom) / 2);
    for (let dx = -1; dx <= 1; dx++) if (ink(x + dx, y)) return labels[y * W + x + dx];
    return 0;
  };
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
      const minRun = Math.max(2 * t, Math.round(0.28 * d));
      const maxRun = Math.round(0.85 * d);
      for (const side of [1, -1]) {
        const x = Math.round(s.x - 0.5 + side * 0.5 * d);
        let cnt = 0;
        let run = 0;
        let runStartY = 0;
        for (let y = ya; y <= yb + 1; y++) {
          const on = y <= yb && (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) && labels[y * W + x] !== 0 ? true : false;
          const inLab = on && (labels[y * W + x] === lab || labels[y * W + x - 1] === lab || labels[y * W + x + 1] === lab);
          if (inLab) {
            if (run === 0) runStartY = y;
            run++;
          } else {
            if (run >= minRun && run <= maxRun) cnt++;
            void runStartY;
            run = 0;
          }
        }
        best = Math.max(best, cnt);
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

  // ---- remaining symbols: dots, accidentals, rests, ties
  const rests: RestSym[] = [];
  const accs: { kind: AccidentalKind; comp: Comp; conf: number }[] = [];
  const dotsC: Comp[] = [];
  const ties: Comp[] = [];
  const restBlobs = sortedRest.filter((c) => !used.has(c.id) && c.x0 >= clefEnd - 1 && c.x1 > musicStart - 0.2 * d);
  for (const c of restBlobs) {
    const w = ww(c);
    const h = hh(c);
    const fill = c.area / (w * h);
    const cyc = half(c);
    if (w <= 0.55 * d && h <= 0.55 * d && w >= 0.15 * d && h >= 0.15 * d && fill >= 0.5) {
      dotsC.push(c);
      continue;
    }
    if (w >= 1.2 * d && h <= 1.4 * d && fill <= 0.65 && h >= 0.2 * d) {
      ties.push(c);
      continue;
    }
    const acc = classifyAccidental(shapeStats(clean, labels, c), d, t);
    if (acc) {
      accs.push({ kind: acc.kind, comp: c, conf: acc.conf });
      continue;
    }
    if (cyc < topL - 0.3 * d || cyc > botL + 0.3 * d) continue;
    if (w >= 0.7 * d && w <= 1.6 * d && h <= 0.85 * d && fill >= 0.7) {
      const dTop = Math.abs(c.y0 - ly(lines[1]));
      const dBot = Math.abs(c.y1 - ly(lines[2]));
      if (Math.min(dTop, dBot) <= 0.45 * d) {
        const kind: RestKind = dTop < dBot ? 'whole' : 'half';
        rests.push({ kind, x0: c.x0 + rx0, x1: c.x1 + rx0, y0: c.y0 + ry0, y1: c.y1 + ry0, dots: 0 });
      }
      continue;
    }
    if (w <= 1.4 * d && h >= 1.2 * d && h <= 3.7 * d) {
      const kind: RestKind = h >= 2.2 * d ? 'quarter' : 'eighth';
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
  // dots → nearest head (or rest)
  for (const c of dotsC) {
    const cx = (c.x0 + c.x1 + 1) / 2;
    const cy = (c.y0 + c.y1 + 1) / 2;
    let bi = -1;
    let bc = Infinity;
    noteheads.forEach((nh, i) => {
      const dx = cx - (nh.cx - rx0);
      const dy = cy - (nh.cy - ry0);
      if (dx < 0.6 * d || dx > 1.7 * d || Math.abs(dy) > 0.6 * d) return;
      const cost = dx + Math.abs(dy);
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
  // ties between equal-pitch heads
  const order = noteheads.map((_, i) => i).sort((a, b) => noteheads[a].cx - noteheads[b].cx);
  for (const c of ties) {
    const cL = c.x0 + rx0;
    const cR = c.x1 + rx0;
    let left = -1;
    let right = -1;
    for (const i of order) {
      const nh = noteheads[i];
      if (Math.abs(nh.cx - cL) <= 1.0 * d && (left < 0 || nh.cx > noteheads[left].cx)) left = i;
    }
    for (const i of order) {
      const nh = noteheads[i];
      if (Math.abs(nh.cx - cR) <= 1.0 * d && nh.cx > cL + 0.5 * d) {
        if (right < 0 || Math.abs(nh.cy - (left >= 0 ? noteheads[left].cy : nh.cy)) < Math.abs(noteheads[right].cy - noteheads[left].cy)) right = i;
      }
    }
    if (left >= 0 && right >= 0 && left !== right) {
      const a = noteheads[left];
      const b = noteheads[right];
      if (Math.abs(a.cy - b.cy) <= 0.3 * d && b.cx > a.cx) b.tiedFromPrevious = true;
    }
  }

  // ---- barlines (merge double / final bars)
  const mergedBars: number[] = [];
  for (const x of barLocal.map((v) => v + rx0).filter((v) => v > musicStart + rx0).sort((a, b) => a - b)) {
    if (mergedBars.length && x - mergedBars[mergedBars.length - 1] < 1.3 * d) mergedBars[mergedBars.length - 1] = x;
    else mergedBars.push(x);
  }
  const barX = mergedBars;

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
  };
}
