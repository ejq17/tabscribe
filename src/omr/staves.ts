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

/** A near-horizontal line segment, tracked across column strips so page skew/curl does not break it. */
interface LineCand {
  /** y at the centre of the segment (x0+x1)/2 */
  y: number;
  /** slope dy/dx (px per px) from a least-squares fit */
  slope: number;
  x0: number;
  x1: number;
  h: number;
  run: number;
}

const yAtX = (c: LineCand, x: number): number => c.y + c.slope * (x - (c.x0 + c.x1) / 2);

/**
 * Staff-line candidates. The page is cut into narrow column strips; in each strip a row whose ink density is high is a
 * line row (skew inside one strip is under a pixel). Line rows in neighbouring strips are linked into tracks, which
 * follow a skewed or curled line across the page. Equivalent to the old whole-page row-run test on a straight page.
 */
function lineCandidates(b: Binary, m: SpacingEstimate): LineCand[] {
  const { width, height, data } = b;
  const d = m.staffSpace;
  const sw = Math.max(48, Math.min(160, Math.round(10 * d)));
  const nStrips = Math.max(1, Math.floor(width / sw));
  const stripW = width / nStrips;
  const maxH = Math.max(2 * m.lineThickness, m.lineThickness + 2) + 1;
  interface Seg {
    y: number;
    h: number;
    xc: number;
  }
  const perStrip: Seg[][] = [];
  for (let si = 0; si < nStrips; si++) {
    const xa = Math.round(si * stripW);
    const xb = Math.round((si + 1) * stripW);
    const need = 0.7 * (xb - xa);
    const segs: Seg[] = [];
    let y = 0;
    let runStart = -1;
    for (y = 0; y <= height; y++) {
      let on = false;
      if (y < height) {
        let c = 0;
        const o = y * width;
        for (let x = xa; x < xb; x++) c += data[o + x];
        on = c >= need;
      }
      if (on) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        const h = y - runStart;
        if (h <= maxH) segs.push({ y: (runStart + y - 1) / 2, h, xc: (xa + xb - 1) / 2 });
        runStart = -1;
      }
    }
    perStrip.push(segs);
  }
  // link into tracks (allow a few missing strips, e.g. where a glyph merges with the line)
  interface Track {
    segs: Seg[];
    lastStrip: number;
  }
  const tracks: Track[] = [];
  const tol = Math.max(1.5, 0.12 * d);
  for (let si = 0; si < nStrips; si++) {
    const taken = new Set<Track>();
    for (const sg of perStrip[si]) {
      let best: Track | null = null;
      let bd = Infinity;
      for (const t of tracks) {
        if (taken.has(t)) continue;
        const gapStrips = si - t.lastStrip;
        if (gapStrips > 4) continue;
        const last = t.segs[t.segs.length - 1];
        // predict with the track slope once it has a few segments
        let pred = last.y;
        if (t.segs.length >= 3) {
          const first = t.segs[0];
          pred = last.y + ((last.y - first.y) / (last.xc - first.xc)) * (sg.xc - last.xc);
        }
        const e = Math.abs(sg.y - pred);
        if (e <= tol * Math.min(gapStrips, 2) && e < bd) {
          bd = e;
          best = t;
        }
      }
      if (best) {
        best.segs.push(sg);
        best.lastStrip = si;
        taken.add(best);
      } else {
        const t = { segs: [sg], lastStrip: si };
        tracks.push(t);
        taken.add(t);
      }
    }
  }
  // stitch collinear tracks separated by a short gap (a glyph fused with the line breaks it in a few strips)
  const startX = (t: Track) => t.segs[0].xc;
  const endX = (t: Track) => t.segs[t.segs.length - 1].xc;
  tracks.sort((a, c) => startX(a) - startX(c));
  const mergedAway = new Set<Track>();
  const mtol = Math.max(2.5, 0.3 * d);
  for (const a of tracks) {
    if (mergedAway.has(a)) continue;
    for (;;) {
      const la = a.segs[a.segs.length - 1];
      let best: Track | null = null;
      let bd = Infinity;
      for (const c of tracks) {
        if (c === a || mergedAway.has(c)) continue;
        const gx = startX(c) - endX(a);
        if (gx <= 0 || gx > 5 * stripW) continue;
        const e = Math.abs(c.segs[0].y - la.y);
        if (e <= mtol && e < bd) {
          bd = e;
          best = c;
        }
      }
      if (!best) break;
      a.segs.push(...best.segs);
      a.lastStrip = best.lastStrip;
      mergedAway.add(best);
    }
  }
  const cands: LineCand[] = [];
  let maxRun = 0;
  const raw = tracks.filter((t) => !mergedAway.has(t)).map((t) => {
    const x0 = t.segs[0].xc - stripW / 2;
    const x1 = t.segs[t.segs.length - 1].xc + stripW / 2;
    const run = (t.segs[t.segs.length - 1].xc - t.segs[0].xc) + stripW;
    if (run > maxRun) maxRun = run;
    return { t, x0, x1, run };
  });
  const minLen = Math.max(5 * d, 0.3 * maxRun);
  for (const { t, x0, x1, run } of raw) {
    if (run < minLen) continue;
    const n = t.segs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, sh = 0;
    for (const sg of t.segs) {
      sx += sg.xc; sy += sg.y; sxx += sg.xc * sg.xc; sxy += sg.xc * sg.y; sh += sg.h;
    }
    const den = n * sxx - sx * sx;
    let slope = den > 1e-9 ? (n * sxy - sx * sy) / den : 0;
    if (n < 3) slope = 0;
    const xm = (x0 + x1) / 2;
    const ym = sy / n + slope * (xm - sx / n);
    cands.push({ y: ym, slope, x0, x1, h: sh / n, run });
  }
  // one physical line can yield two tracks (broken row in a strip, jog between strips): keep the longer of any pair that
  // sit on top of each other
  cands.sort((a, c) => c.run - a.run);
  const kept: LineCand[] = [];
  for (const c of cands) {
    const dup = kept.some((k) => {
      const lo = Math.max(k.x0, c.x0);
      const hi = Math.min(k.x1, c.x1);
      if (hi - lo < 2 * d) return false;
      const xm = (lo + hi) / 2;
      return Math.abs(yAtX(k, xm) - yAtX(c, xm)) < Math.max(2.5, 0.35 * d);
    });
    if (!dup) kept.push(c);
  }
  kept.sort((a, c) => yAtX(a, b.width / 2) - yAtX(c, b.width / 2));
  return kept;
}

function sampleBands(b: Binary, lines: number[], left: number, right: number, d: number, slope = 0, xRef = 0): StaffBand[] {
  const { width, data } = b;
  const bw = Math.max(20, Math.round(4 * d));
  const bands: StaffBand[] = [];
  // `lines` are the line rows at x = xRef; a skewed staff is followed by seeding each band from the fitted slope
  const pitch = (lines[4] - lines[0]) / 4;
  const last = lines.map((y) => y + slope * (left - xRef));
  for (let x0 = left; x0 <= right; x0 += bw) {
    const x1 = Math.min(right + 1, x0 + bw);
    if (x1 - x0 < bw / 2 && bands.length > 0) break;
    if (slope !== 0 && bands.length > 0) for (let i = 0; i < 5; i++) last[i] += slope * bw;
    const ys: number[] = [];
    const found: (number | null)[] = [null, null, null, null, null];
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
      found[i] = yy;
    }
    // A staff is rigid: noteheads, ledger lines and beams that sit next to a line must not drag that one line away from
    // the others. Take the median offset of the lines that were seen clearly and place all five on one equally
    // spaced grid (the grid still follows slow curl, because it is re-fitted in every band).
    const seen = found.map((y, i) => (y === null ? null : y - i * pitch)).filter((v): v is number => v !== null);
    if (seen.length >= 3) {
      seen.sort((u, v) => u - v);
      const base = seen[seen.length >> 1];
      for (let i = 0; i < 5; i++) ys[i] = base + i * pitch;
    }
    for (let i = 0; i < 5; i++) last[i] = ys[i];
    bands.push({ x: (x0 + x1 - 1) / 2, ys });
  }
  if (bands.length === 0) bands.push({ x: (left + right) / 2, ys: lines.map((y) => y + slope * ((left + right) / 2 - xRef)) });
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

function findExtent(b: Binary, lines: number[], d: number, slope = 0, xRef = 0): { left: number; right: number } | null {
  const { width, height, data } = b;
  const ok = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    let c = 0;
    const dy = slope * (x - xRef);
    for (const y0 of lines) {
      const r = Math.round(y0 + dy);
      if (r < 1 || r >= height - 1) continue;
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
      const xc = b.width / 2;
      const py = yAtX(cands[prev], xc);
      for (let j = prev + 1; j < cands.length; j++) {
        // sorted by y at the page centre; skew moves a line by a few px elsewhere, hence the slack
        if (yAtX(cands[j], xc) - py > d + tol + 0.6 * d) break;
        const lo = Math.max(cands[j].x0, cands[prev].x0);
        const hi = Math.min(cands[j].x1, cands[prev].x1);
        if (hi - lo < 4 * d) continue;
        const xm = (lo + hi) / 2;
        const gap = yAtX(cands[j], xm) - yAtX(cands[prev], xm);
        if (gap > d + tol) continue;
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
    // evaluate all five lines at the middle of their common horizontal extent
    const lo = Math.max(...chain.map((k) => cands[k].x0));
    const hi = Math.min(...chain.map((k) => cands[k].x1));
    if (hi - lo < 4 * d) continue;
    const xRef = (lo + hi) / 2;
    const slope = chain.reduce((acc, k) => acc + cands[k].slope, 0) / 5;
    const ys = chain.map((k) => yAtX(cands[k], xRef));
    const pitch = (ys[4] - ys[0]) / 4;
    if (Math.abs(pitch - d) > tol) continue;
    const ext = findExtent(b, ys, d, slope, xRef);
    if (!ext) continue;
    chain.forEach((k) => (used[k] = true));
    const bands = sampleBands(b, ys, ext.left, ext.right, d, slope, xRef);
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
