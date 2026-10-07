/**
 * Tie detection on the staff-line-stripped crop: a tie is a thin curved arc that starts beside one notehead, bows away
 * from it and ends beside the next notehead of the SAME pitch (same y within 0.3 staff space). The arc is found with a
 * small dynamic program over columns, so it survives gaps where it crosses a staff line, a barline or a stem, and it
 * works when the arc is merged into the head's component.
 */
import type { Notehead, Staff } from './types';
import { lineY } from './staves';

export interface TieImage {
  w: number;
  h: number;
  /** 1 = ink (staff lines removed) */
  d: Uint8Array;
}

export interface TieResult {
  /** indices (into the head array) of [left, right] pairs */
  pairs: [number, number][];
  /** head indices whose arc runs off the end of the staff */
  out: number[];
}

interface Path {
  score: number;
  coverage: number;
  bow: number;
  ok: boolean;
  maxMiss: number;
  thin?: number;
  neutral?: number;
  nIn?: number;
}

/** Vertical run length of the ink pixel at every position (0 for paper). */
function vRuns(img: TieImage): Uint16Array {
  const { w, h, d } = img;
  const out = new Uint16Array(w * h);
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
  return out;
}

/** Rows covered by a staff line (everywhere) or a ledger line (near heads that need one); an arc may pass through them. */
function lineMask(img: TieImage, staff: Staff, heads: Notehead[], ox: number, oy: number): Uint8Array {
  const { w, h } = img;
  const m = new Uint8Array(w * h);
  const sp = staff.staffSpace;
  const tol = staff.lineThickness / 2 + 0.3;
  const mark = (x: number, c: number, extra = 0) => {
    // c is the (fractional) centre row of a line
    for (let y = Math.max(0, Math.ceil(c - tol - extra)); y <= Math.min(h - 1, Math.floor(c + tol + extra)); y++) m[y * w + x] = 1;
  };
  for (let x = 0; x < w; x++) for (let li = 0; li < 5; li++) mark(x, lineY(staff, li, x + ox) - oy);
  for (const hd of heads) {
    const above = lineY(staff, 0, hd.cx) - hd.cy;
    const below = hd.cy - lineY(staff, 4, hd.cx);
    const n = Math.floor(Math.max(above, below) / sp + 0.15);
    if (n < 1) continue;
    for (let k = 1; k <= n; k++) {
      const cy = (above > below ? lineY(staff, 0, hd.cx) - k * sp : lineY(staff, 4, hd.cx) + k * sp) - oy;
      for (let x = Math.max(0, Math.round(hd.cx - ox - 1.6 * sp)); x <= Math.min(w - 1, Math.round(hd.cx - ox + 1.6 * sp)); x++) mark(x, cy, 0.9);
    }
  }
  return m;
}

/**
 * Trace the best thin arc on one side of a head (dir = -1 above, +1 below) between columns xa..xb (local coordinates).
 * `cy` is the head's centre row, `freeA` / `freeB` the number of columns at each end where missing ink is not penalised.
 */
function traceArc(img: TieImage, run: Uint16Array, lm: Uint8Array, d: number, cx: number, cy: number, dir: number, xa: number, xb: number, freeA: number, freeB: number, maxRun: number, longRun: number): Path {
  const bad: Path = { score: -1e9, coverage: 0, bow: 0, ok: false, maxMiss: 0 };
  const { w, h, d: data } = img;
  xa = Math.max(0, Math.round(xa));
  xb = Math.min(w - 1, Math.round(xb));
  const n = xb - xa + 1;
  if (n < Math.round(1.2 * d)) return bad;
  const off0 = Math.round(0.2 * d);
  const off1 = Math.round(1.9 * d);
  const endMax = Math.round(1.25 * d) - off0;
  const R = off1 - off0 + 1;
  const rowOf = (r: number): number => Math.round(cy + dir * (off0 + r));
  const val = new Int8Array(n * R); // 1 thin ink, -1 empty, 0 exempt
  const thinCount = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = xa + i;
    // an exempt column: a tall vertical stroke (barline / stem) crosses the window
    let tall = false;
    for (let r = 0; r < R && !tall; r++) {
      const y = rowOf(r);
      if (y >= 0 && y < h && run[y * w + x] >= longRun) tall = true;
    }
    for (let r = 0; r < R; r++) {
      const y = rowOf(r);
      let v = -1;
      const onLine = y >= 0 && y < h && lm[y * w + x] === 1;
      if (onLine || (tall && !(y >= 0 && y < h && data[y * w + x] && run[y * w + x] <= maxRun))) v = 0;
      else if (y >= 0 && y < h && data[y * w + x]) v = run[y * w + x] <= maxRun ? 1 : -1;
      if (v === -1 && (i < freeA || i >= n - freeB)) v = 0;
      val[i * R + r] = v;
      if (v === 1) thinCount[i]++;
    }
  }
  const NEG = -1e9;
  const dp = new Float32Array(n * R).fill(NEG);
  const bp = new Int8Array(n * R);
  for (let r = 0; r <= Math.min(R - 1, endMax); r++) dp[r] = val[r];
  const maxStep = 2;
  for (let i = 1; i < n; i++) {
    for (let r = 0; r < R; r++) {
      let best = NEG;
      let bs = 0;
      for (let s = -maxStep; s <= maxStep; s++) {
        const pr = r + s;
        if (pr < 0 || pr >= R) continue;
        const sc = dp[(i - 1) * R + pr] - 0.12 * Math.abs(s);
        if (sc > best) {
          best = sc;
          bs = s;
        }
      }
      dp[i * R + r] = best + val[i * R + r];
      bp[i * R + r] = bs;
    }
  }
  let bestR = 0;
  let bestV = NEG;
  for (let r = 0; r <= Math.min(R - 1, endMax); r++) if (dp[(n - 1) * R + r] > bestV) {
    bestV = dp[(n - 1) * R + r];
    bestR = r;
  }
  const rows = new Int32Array(n);
  let r = bestR;
  for (let i = n - 1; i >= 0; i--) {
    rows[i] = r;
    if (i > 0) r = r + bp[i * R + r];
  }
  let thin = 0;
  let miss = 0;
  let neutral = 0;
  let missRun = 0;
  let maxMiss = 0;
  for (let i = freeA; i < n - freeB; i++) {
    const v = val[i * R + rows[i]];
    if (v === 1) {
      thin++;
      missRun = 0;
    } else if (v === 0) neutral++;
    else {
      miss++;
      missRun++;
      if (missRun > maxMiss) maxMiss = missRun;
    }
  }
  const nIn = Math.max(1, n - freeA - freeB);
  const coverage = thin + miss > 0 ? thin / (thin + miss) : 0;
  // bow: how far the middle of the arc sits beyond the average of its two ends
  const k = Math.max(1, Math.round(0.4 * d));
  const startOff = rows.slice(0, k).reduce((s, v) => s + v, 0) / Math.min(k, n);
  const endOff = rows.slice(n - k).reduce((s, v) => s + v, 0) / Math.min(k, n);
  let mid = -Infinity;
  for (let i = 0; i < n; i++) mid = Math.max(mid, rows[i]);
  const bow = mid - (startOff + endOff) / 2;
  void cx;
  const ok = coverage >= 0.82 && thin >= 0.5 * nIn && neutral <= 0.4 * nIn && maxMiss <= Math.max(3, Math.round(0.9 * d)) && bow >= 0.15 * d;
  return { score: bestV, coverage, bow, ok, maxMiss, thin, neutral, nIn };
}

/**
 * Find ties for the heads of one staff. `heads` are in local crop coordinates (cx, cy) and need not be sorted.
 * `rightEdge` is the local x of the staff's right end.
 */
export function detectTies(img: TieImage, staff: Staff, heads: Notehead[], ox: number, oy: number): TieResult {
  const d = staff.staffSpace;
  const t = staff.lineThickness;
  const rightEdge = staff.right - ox;
  const run = vRuns(img);
  const lm = lineMask(img, staff, heads, ox, oy);
  const maxRun = Math.round(0.5 * d) + t + 1;
  const longRun = Math.round(1.6 * d);
  const idx = heads.map((_, i) => i).sort((a, b) => heads[a].cx - heads[b].cx);
  const pairs: [number, number][] = [];
  const out: number[] = [];
  const lcx = (h: Notehead) => h.cx - ox;
  const lcy = (h: Notehead) => h.cy - oy;
  for (let a = 0; a < idx.length; a++) {
    const hi = idx[a];
    const H = heads[hi];
    // candidate partner: first head to the right (not in the same chord column) at the same pitch
    let partner = -1;
    let blocked = false;
    let sawBetween = false;
    for (let b = a + 1; b < idx.length; b++) {
      const G = heads[idx[b]];
      if (G.cx - H.cx < 1.6 * d) continue;
      if (Math.abs(G.cy - H.cy) <= 0.3 * d) {
        // heads between H and G in time block the tie (the arc would be a slur over them)
        partner = idx[b];
        break;
      }
      if (G.cx - H.cx > 80 * d) break;
      // another pitch strictly between: only blocks when it sits clearly between the two onsets
      sawBetween = true;
    }
    if (partner >= 0) {
      const G = heads[partner];
      for (const o of heads) {
        if (o === H || o === G) continue;
        if (o.cx > H.cx + 1.0 * d && o.cx < G.cx - 1.0 * d) blocked = true;
      }
    }
    void sawBetween;
    const cx = lcx(H);
    const cy = lcy(H);
    if (partner >= 0 && !blocked) {
      const G = heads[partner];
      const gx = lcx(G);
      const xa = cx + 0.62 * d;
      const xb = gx - 0.62 * d;
      let best: Path | null = null;
      for (const dir of [-1, 1]) {
        const p = traceArc(img, run, lm, d, cx, cy, dir, xa, xb, Math.round(0.6 * d), Math.round(0.6 * d), maxRun, longRun);
        if (p.ok && (!best || p.score > best.score)) best = p;
      }
      if (best) {
        pairs.push([hi, partner]);
        continue;
      }
    }
    // an arc that runs off the end of the staff (tie across the line break)
    const isLast = !idx.slice(a + 1).some((j) => heads[j].cx - H.cx > 1.0 * d);
    if (isLast && rightEdge - cx > 2.0 * d) {
      let best: Path | null = null;
      for (const stop of [0.4, 1.2]) {
        const xb = rightEdge - stop * d;
        if (xb - cx < 3 * d) continue;
        for (const dir of [-1, 1]) {
          const p = traceArc(img, run, lm, d, cx, cy, dir, cx + 0.62 * d, xb, Math.round(0.6 * d), Math.round(0.9 * d), maxRun, longRun);
          if (p.ok && p.bow >= 0.45 * d && (!best || p.score > best.score)) best = p;
        }
      }
      if (best) out.push(hi);
    }
  }
  return { pairs, out };
}
