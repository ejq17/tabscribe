import type { Binary, Staff, StaffBand } from './types';

export interface SpacingEstimate {
  staffSpace: number;
  lineThickness: number;
}

/** Run-length histogram method: most common (black run + white run) = staff line pitch. */
export function estimateStaffMetrics(b: Binary): SpacingEstimate | null {
  const { width, height, data } = b;
  const MAXP = 120;
  const pairHist = new Float64Array(MAXP + 2);
  const blackByPair: Float64Array[] = [];
  for (let i = 0; i <= MAXP + 1; i++) blackByPair.push(new Float64Array(0));
  const blackHist = new Float64Array(MAXP + 2);
  // first pass: pair histogram; second pass: black-run histogram constrained by pair
  const colStep = Math.max(1, Math.floor(width / 1500));
  const pairs: number[] = [];
  for (let x = 0; x < width; x += colStep) {
    let y = 0;
    while (y < height) {
      while (y < height && !data[y * width + x]) y++;
      if (y >= height) break;
      const bs = y;
      while (y < height && data[y * width + x]) y++;
      const blen = y - bs;
      const ws = y;
      while (y < height && !data[y * width + x]) y++;
      const wlen = y - ws;
      if (y >= height && wlen === 0) break;
      if (y >= height) break; // trailing white run is meaningless
      if (blen <= MAXP && blen + wlen <= MAXP) {
        pairHist[blen + wlen]++;
        pairs.push(blen, blen + wlen);
      }
    }
  }
  let bestD = -1;
  let bestScore = 0;
  for (let d = 4; d <= MAXP; d++) {
    const s = pairHist[d - 1] + pairHist[d] * 1.0 + pairHist[d + 1];
    if (s > bestScore) {
      bestScore = s;
      bestD = d;
    }
  }
  if (bestD < 0 || bestScore < 30) return null;
  for (let i = 0; i < pairs.length; i += 2) {
    const sum = pairs[i + 1];
    if (Math.abs(sum - bestD) <= 1) blackHist[pairs[i]]++;
  }
  let bt = 1;
  let btv = 0;
  for (let t = 1; t < bestD / 2; t++) {
    if (blackHist[t] > btv) {
      btv = blackHist[t];
      bt = t;
    }
  }
  // refine d as weighted mean around the peak
  let wsum = 0;
  let w = 0;
  for (let d = bestD - 1; d <= bestD + 1; d++) {
    wsum += d * pairHist[d];
    w += pairHist[d];
  }
  return { staffSpace: w > 0 ? wsum / w : bestD, lineThickness: bt };
}

function longestRowRuns(b: Binary, maxGap: number): Int32Array {
  const { width, height, data } = b;
  const out = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let best = 0;
    let runStart = -1;
    let lastInk = -1;
    for (let x = 0; x < width; x++) {
      if (data[o + x]) {
        if (runStart < 0) runStart = x;
        lastInk = x;
      } else if (runStart >= 0 && x - lastInk > maxGap) {
        best = Math.max(best, lastInk - runStart + 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) best = Math.max(best, lastInk - runStart + 1);
    out[y] = best;
  }
  return out;
}

interface LineCand {
  y: number;
  h: number;
  run: number;
}

function lineCandidates(b: Binary, m: SpacingEstimate): LineCand[] {
  const { height } = b;
  const runs = longestRowRuns(b, 1);
  let maxRun = 0;
  for (let y = 0; y < height; y++) if (runs[y] > maxRun) maxRun = runs[y];
  const minLen = Math.max(5 * m.staffSpace, 0.3 * maxRun);
  const maxH = Math.max(2 * m.lineThickness, m.lineThickness + 2);
  const out: LineCand[] = [];
  let y = 0;
  while (y < height) {
    if (runs[y] >= minLen) {
      const s = y;
      let runSum = 0;
      while (y < height && runs[y] >= minLen) {
        runSum += runs[y];
        y++;
      }
      const h = y - s;
      if (h <= maxH) out.push({ y: (s + y - 1) / 2, h, run: runSum / h });
    } else y++;
  }
  return out;
}

function sampleBands(b: Binary, lines: number[], left: number, right: number, d: number): StaffBand[] {
  const { width, data } = b;
  const bw = Math.max(20, Math.round(4 * d));
  const bands: StaffBand[] = [];
  const last = lines.slice();
  for (let x0 = left; x0 <= right; x0 += bw) {
    const x1 = Math.min(right + 1, x0 + bw);
    if (x1 - x0 < bw / 2 && bands.length > 0) break;
    const ys: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = last[i];
      const ya = Math.max(0, Math.round(c - 0.45 * d));
      const yb = Math.min(b.height - 1, Math.round(c + 0.45 * d));
      const sums: number[] = [];
      let best = 0;
      let bi = ya;
      for (let y = ya; y <= yb; y++) {
        let s = 0;
        for (let x = x0; x < x1 && x < width; x++) s += data[y * width + x];
        sums.push(s);
        if (s > best) {
          best = s;
          bi = y;
        }
      }
      if (best < 0.4 * (x1 - x0)) {
        ys.push(last[i]);
        continue;
      }
      // centroid of the contiguous rows around bi with sum >= 0.6 max
      let a = bi;
      let z = bi;
      while (a - 1 >= ya && sums[a - 1 - ya] >= 0.6 * best) a--;
      while (z + 1 <= yb && sums[z + 1 - ya] >= 0.6 * best) z++;
      const yy = (a + z) / 2;
      ys.push(yy);
      last[i] = yy;
    }
    bands.push({ x: (x0 + x1 - 1) / 2, ys });
  }
  if (bands.length === 0) bands.push({ x: (left + right) / 2, ys: lines.slice() });
  return bands;
}

/** y of staff line `i` (0 = top) at column x, interpolated between column bands. */
export function lineY(staff: Staff, i: number, x: number): number {
  const bs = staff.bands;
  if (bs.length === 1 || x <= bs[0].x) return bs[0].ys[i];
  if (x >= bs[bs.length - 1].x) return bs[bs.length - 1].ys[i];
  // bands are evenly spaced
  const step = bs[1].x - bs[0].x;
  let k = Math.floor((x - bs[0].x) / step);
  if (k >= bs.length - 1) k = bs.length - 2;
  if (k < 0) k = 0;
  const a = bs[k];
  const c = bs[k + 1];
  const f = (x - a.x) / (c.x - a.x);
  return a.ys[i] + (c.ys[i] - a.ys[i]) * f;
}

function findExtent(b: Binary, lines: number[], d: number): { left: number; right: number } | null {
  const { width, data } = b;
  const rows = lines.map((y) => Math.round(y));
  const ok = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    let c = 0;
    for (const r of rows) {
      if (data[r * width + x] || data[(r - 1) * width + x] || data[(r + 1) * width + x]) c++;
    }
    ok[x] = c >= 4 ? 1 : 0;
  }
  const gap = Math.max(6, Math.round(3 * d));
  // raw runs of "line-like" columns; drop short ones (braces, barlines) then merge across small gaps
  const runs: { l: number; r: number }[] = [];
  let x = 0;
  while (x < width) {
    if (!ok[x]) {
      x++;
      continue;
    }
    const s = x;
    while (x < width && ok[x]) x++;
    if (x - s >= 2 * d) runs.push({ l: s, r: x - 1 });
  }
  let bestL = -1;
  let bestR = -1;
  let curL = -1;
  let curR = -1;
  for (const r of runs) {
    if (curL >= 0 && r.l - curR <= gap) curR = r.r;
    else {
      curL = r.l;
      curR = r.r;
    }
    if (curR - curL > bestR - bestL) {
      bestL = curL;
      bestR = curR;
    }
  }
  if (bestL < 0 || bestR - bestL < 4 * d) return null;
  return { left: bestL, right: bestR };
}

/** Detect staves (5 equally spaced lines) in a binary page. */
export function detectStaves(b: Binary): Staff[] {
  const m = estimateStaffMetrics(b);
  if (!m) return [];
  const d = m.staffSpace;
  const cands = lineCandidates(b, m);
  const used = new Array(cands.length).fill(false);
  const staves: Staff[] = [];
  const tol = 0.2 * d;
  for (let i = 0; i < cands.length; i++) {
    if (used[i]) continue;
    const chain = [i];
    let prev = i;
    while (chain.length < 5) {
      let bj = -1;
      let bd = Infinity;
      for (let j = prev + 1; j < cands.length; j++) {
        const gap = cands[j].y - cands[prev].y;
        if (gap > d + tol) break;
        if (gap < d - tol) continue;
        const e = Math.abs(gap - d);
        if (e < bd) {
          bd = e;
          bj = j;
        }
      }
      if (bj < 0) break;
      chain.push(bj);
      prev = bj;
    }
    if (chain.length < 5) continue;
    const ys = chain.map((k) => cands[k].y);
    const pitch = (ys[4] - ys[0]) / 4;
    if (Math.abs(pitch - d) > tol) continue;
    const ext = findExtent(b, ys, d);
    if (!ext) continue;
    chain.forEach((k) => (used[k] = true));
    const bands = sampleBands(b, ys, ext.left, ext.right, d);
    const mean = [0, 1, 2, 3, 4].map((li) => bands.reduce((s, bd2) => s + bd2.ys[li], 0) / bands.length);
    staves.push({
      lines: mean,
      bands,
      left: ext.left,
      right: ext.right,
      staffSpace: (mean[4] - mean[0]) / 4,
      lineThickness: m.lineThickness,
      top: mean[0],
      bottom: mean[4],
      system: 0,
      partIndex: 0,
      lowerOfGrand: false,
    });
  }
  staves.sort((a, c) => a.top - c.top);
  groupSystems(b, staves);
  return staves;
}

/** Fraction of ink in the column band left of a staff between two vertical positions. */
function braceCoverage(b: Binary, x0: number, x1: number, y0: number, y1: number): number {
  const { width, data } = b;
  let best = 0;
  for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
    let c = 0;
    let n = 0;
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(b.height - 1, Math.ceil(y1)); y++) {
      n++;
      if (data[y * width + x]) c++;
    }
    if (n > 0) best = Math.max(best, c / n);
  }
  return best;
}

/**
 * Assign `system` / `partIndex`; mark piano grand staves (two staves close together joined by a brace/system barline
 * at the left edge: the lower staff is bass).
 */
export function groupSystems(b: Binary, staves: Staff[]): number[][] {
  const systems: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < staves.length; i++) {
    const s = staves[i];
    if (i > 0) {
      const p = staves[i - 1];
      const d = Math.min(s.staffSpace, p.staffSpace);
      const gap = s.top - p.bottom;
      const aligned = Math.abs(s.left - p.left) < 2 * d;
      if (aligned && gap < 8 * d && cur.length === 1) {
        // brace / connecting barline in the gap rows left of the staves
        const cov = braceCoverage(b, p.left - 3 * d, p.left + 0.3 * d, p.bottom + 0.3 * d, s.top - 0.3 * d);
        if (cov >= 0.7) {
          cur.push(i);
          s.lowerOfGrand = true;
          continue;
        }
      }
      systems.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) systems.push(cur);
  systems.forEach((sys, si) =>
    sys.forEach((k, pi) => {
      staves[k].system = si;
      staves[k].partIndex = pi;
    }),
  );
  return systems;
}

export function systemsOf(staves: Staff[]): number[][] {
  const out: number[][] = [];
  staves.forEach((s, i) => {
    (out[s.system] ??= []).push(i);
  });
  return out.filter(Boolean);
}

/**
 * Remove staff lines from a cropped binary image. Pixels on a line row are cleared when the vertical run of ink they
 * belong to is at most lineThickness + 2 (symbols crossing the line produce longer runs and are kept).
 * `src` is a crop whose top-left is (ox, oy) in page coordinates.
 */
export function removeStaffLines(src: Binary, staff: Staff, ox: number, oy: number): Binary {
  const { width, height, data } = src;
  const out = new Uint8Array(data);
  const t = staff.lineThickness;
  const limit = t + 2;
  const half = Math.ceil(t / 2) + 1;
  for (let li = 0; li < 5; li++) {
    for (let x = 0; x < width; x++) {
      const px = x + ox;
      if (px < staff.left - 1 || px > staff.right + 1) continue;
      const cy = Math.round(lineY(staff, li, px)) - oy;
      for (let y = Math.max(0, cy - half); y <= Math.min(height - 1, cy + half); y++) {
        if (!data[y * width + x]) continue;
        let up = 0;
        let yy = y - 1;
        while (yy >= 0 && data[yy * width + x] && up <= limit) {
          up++;
          yy--;
        }
        let dn = 0;
        yy = y + 1;
        while (yy < height && data[yy * width + x] && dn <= limit) {
          dn++;
          yy++;
        }
        if (up + dn + 1 <= limit) out[y * width + x] = 0;
      }
    }
  }
  return { width, height, data: out };
}
