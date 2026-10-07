/**
 * Glyph-level detectors that work directly on small binary crops (1 = ink):
 *  - hollow noteheads (elliptical rings, optionally split by a staff line passing through the hole)
 *  - key signatures (flat / sharp clusters found through their vertical strokes)
 *  - multi-measure rests (thick horizontal bars on the middle line)
 * Everything here is pure and DOM free.
 */

export interface GImg {
  w: number;
  h: number;
  /** 1 = ink */
  d: Uint8Array;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hollow noteheads

export interface HollowHead {
  cx: number;
  cy: number;
  /** half width of the hole */
  holeHW: number;
  outerW: number;
  outerH: number;
  conf: number;
}

interface BgComp {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  border: boolean;
}

function labelBackground(img: GImg): { lab: Int32Array; comps: BgComp[] } {
  const { w, h, d } = img;
  const lab = new Int32Array(w * h);
  const comps: BgComp[] = [];
  const stack = new Int32Array(w * h);
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const i0 = y0 * w + x0;
      if (d[i0] || lab[i0]) continue;
      const id = comps.length + 1;
      const c: BgComp = { id, x0, y0, x1: x0, y1: y0, area: 0, border: false };
      let sp = 0;
      stack[sp++] = i0;
      lab[i0] = id;
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % w;
        const py = (p - px) / w;
        c.area++;
        if (px < c.x0) c.x0 = px;
        if (px > c.x1) c.x1 = px;
        if (py < c.y0) c.y0 = py;
        if (py > c.y1) c.y1 = py;
        if (px === 0 || py === 0 || px === w - 1 || py === h - 1) c.border = true;
        if (px > 0 && !d[p - 1] && !lab[p - 1]) {
          lab[p - 1] = id;
          stack[sp++] = p - 1;
        }
        if (px < w - 1 && !d[p + 1] && !lab[p + 1]) {
          lab[p + 1] = id;
          stack[sp++] = p + 1;
        }
        if (py > 0 && !d[p - w] && !lab[p - w]) {
          lab[p - w] = id;
          stack[sp++] = p - w;
        }
        if (py < h - 1 && !d[p + w] && !lab[p + w]) {
          lab[p + w] = id;
          stack[sp++] = p + w;
        }
      }
      comps.push(c);
    }
  }
  return { lab, comps };
}

interface HoleCand {
  ids: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** pixels (a staff line segment) that are treated as background for ray casting */
  fill?: { x0: number; y0: number; x1: number; y1: number };
  /** row used for horizontal rays */
  rowH: number;
}

/**
 * Find hollow noteheads. `img` is the ORIGINAL crop (staff lines still present). A hollow head is an elliptical ring
 * whose hole is a small enclosed background region (or two half-holes stacked on either side of a staff line).
 * `lineYAt(x, i)` returns the local y of staff line i (0 = top) at column x.
 */
export function findHollowHeads(img: GImg, d: number, t: number, lineYAt: (x: number, i: number) => number, onReject?: (why: string, x: number, y: number) => void): HollowHead[] {
  const rej = (why: string, hc: { x0: number; x1: number; y0: number; y1: number }) => onReject?.(why, (hc.x0 + hc.x1) / 2, (hc.y0 + hc.y1) / 2);
  const { w, h, d: data } = img;
  const { lab, comps } = labelBackground(img);
  const small = comps.filter((c) => {
    if (c.border) return false;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    return c.area >= 3 && bw >= 0.22 * d && bw <= 1.25 * d && bh >= 2 && bh <= 1.05 * d && c.area <= 1.4 * d * d;
  });
  const cands: HoleCand[] = [];
  const merged = new Set<number>();
  // pair holes split by a staff line
  for (const a of small) {
    for (const b of small) {
      if (b.y0 <= a.y1) continue;
      const gap = b.y0 - a.y1 - 1;
      if (gap < 1 || gap > t + 3) continue;
      const ox0 = Math.max(a.x0, b.x0);
      const ox1 = Math.min(a.x1, b.x1);
      const ov = ox1 - ox0 + 1;
      const minW = Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1);
      if (ov < 0.3 * minW) continue;
      const gy = (a.y1 + b.y0) / 2;
      const cx = (ox0 + ox1) / 2;
      let onLine = false;
      // staff lines (0..4) and ledger-line positions above / below the staff
      for (let i = -6; i <= 10; i++) if (Math.abs(lineYAt(cx, i) - gy) <= (t + 3) / 2 + 0.5) onLine = true;
      if (!onLine) continue;
      const biggerA = a.area >= b.area;
      cands.push({
        ids: [a.id, b.id],
        x0: Math.min(a.x0, b.x0),
        x1: Math.max(a.x1, b.x1),
        y0: a.y0,
        y1: b.y1,
        area: a.area + b.area + gap * ov,
        fill: { x0: ox0, x1: ox1, y0: a.y1 + 1, y1: b.y0 - 1 },
        rowH: Math.round(biggerA ? (a.y0 + a.y1) / 2 : (b.y0 + b.y1) / 2),
      });
      merged.add(a.id);
      merged.add(b.id);
    }
  }
  for (const c of small) {
    // a half hole that is also valid alone is still tried alone (ring above a line etc.)
    if (c.x1 - c.x0 + 1 < 0.3 * d || c.y1 - c.y0 + 1 < 0.28 * d) continue;
    cands.push({ ids: [c.id], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area, rowH: Math.round((c.y0 + c.y1) / 2) });
  }

  const inkAt = (x: number, y: number, hc: HoleCand): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (hc.fill && x >= hc.fill.x0 && x <= hc.fill.x1 && y >= hc.fill.y0 && y <= hc.fill.y1) return false;
    return data[y * w + x] === 1;
  };
  const capS = Math.round(0.85 * d);
  const ray = (hc: HoleCand, sx: number, sy: number, dx: number, dy: number): { s0: number; th: number; ok: boolean } => {
    const unit = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
    let s = 0;
    // leave the hole
    while (s <= capS && !inkAt(sx + dx * s, sy + dy * s, hc)) s++;
    if (s > capS) return { s0: capS, th: 0, ok: false };
    const s0 = s;
    while (s - s0 <= capS && inkAt(sx + dx * s, sy + dy * s, hc)) s++;
    const th = (s - s0) * unit;
    return { s0: s0 * unit, th, ok: th >= 1 && th <= 0.62 * d };
  };

  const out: HollowHead[] = [];
  for (const hc of cands) {
    const bw = hc.x1 - hc.x0 + 1;
    const bh = hc.y1 - hc.y0 + 1;
    if (bw < 0.3 * d || bh < 0.28 * d){ rej('r1', hc); continue; }
    const fillRatio = hc.area / (bw * bh);
    if (fillRatio < 0.45){ rej('r2', hc); continue; }
    // ellipse-like: at least 3 of the 4 bbox corners must not belong to the hole
    let cornersOut = 0;
    for (const [px, py] of [
      [hc.x0, hc.y0],
      [hc.x1, hc.y0],
      [hc.x0, hc.y1],
      [hc.x1, hc.y1],
    ]) {
      const l = lab[py * w + px];
      if (!hc.ids.includes(l)) cornersOut++;
    }
    if (cornersOut < 3 && !hc.fill){ rej('r3', hc); continue; }
    const cx = Math.round((hc.x0 + hc.x1) / 2);
    const cy = Math.round((hc.y0 + hc.y1) / 2);
    // horizontal / vertical rays: try a few rows / columns (the staff line may run through the hole's centre row)
    const rowsTry = hc.fill ? [hc.rowH] : [cy, cy - Math.round(bh / 4), cy + Math.round(bh / 4), cy - 1, cy + 1];
    let L = ray(hc, cx, cy, -1, 0);
    let R = ray(hc, cx, cy, 1, 0);
    for (const r of rowsTry) {
      if (r < hc.y0 || r > hc.y1)continue;
      if (inkAt(cx, r, hc))continue;
      const l2 = ray(hc, cx, r, -1, 0);
      const r2 = ray(hc, cx, r, 1, 0);
      if (l2.ok && r2.ok) {
        L = l2;
        R = r2;
        break;
      }
    }
    let U = ray(hc, cx, cy, 0, -1);
    let D = ray(hc, cx, cy, 0, 1);
    for (const c2 of [cx, cx - Math.round(bw / 4), cx + Math.round(bw / 4)]) {
      if (c2 < hc.x0 || c2 > hc.x1 || inkAt(c2, cy, hc))continue;
      const u2 = ray(hc, c2, cy, 0, -1);
      const d2 = ray(hc, c2, cy, 0, 1);
      if (u2.ok && d2.ok) {
        U = u2;
        D = d2;
        break;
      }
    }
    if (!(L.ok && R.ok && U.ok && D.ok)){ rej('r7', hc); continue; }
    const diag = [ray(hc, cx, cy, -1, -1), ray(hc, cx, cy, 1, -1), ray(hc, cx, cy, -1, 1), ray(hc, cx, cy, 1, 1)];
    const goodDiag = diag.filter((r) => r.ok).length;
    if (goodDiag < 1){ rej('r8', hc); continue; }
    const outerW = L.s0 + L.th + R.s0 + R.th;
    const outerH = U.s0 + U.th + D.s0 + D.th;
    if (outerW < 0.95 * d || outerW > 2.0 * d || outerH < 0.7 * d || outerH > 1.6 * d){ rej('r9', hc); continue; }
    if (outerW < 0.8 * outerH){ rej('r10', hc); continue; } // heads are wider than tall
    // flat sign look-alike: a long stroke rising from the left edge
    {
      const leftEdge = Math.round(cx - outerW / 2);
      const topY = Math.round(cy - outerH / 2);
      let best = 0;
      for (let x = leftEdge - 1; x <= leftEdge + 3; x++) {
        let y = topY;
        let n = 0;
        while (y >= 0 && data[y * w + x] === 1) {
          n++;
          y--;
        }
        if (n > best) best = n;
      }
      const rightEdge = Math.round(cx + outerW / 2);
      let bestR = 0;
      for (let x = rightEdge - 3; x <= rightEdge + 1; x++) {
        let y = topY;
        let n = 0;
        while (y >= 0 && data[y * w + x] === 1) {
          n++;
          y--;
        }
        if (n > bestR) bestR = n;
      }
      if (best >= 1.5 * d && bestR < 1.0 * d && outerW < 1.15 * d){ rej('r11', hc); continue; }
    }
    const conf = 0.6 + 0.3 * ((goodDiag + 4) / 8) * (fillRatio > 0.55 ? 1 : 0.85);
    out.push({ cx: hc.fill ? (hc.fill.x0 + hc.fill.x1 + 1) / 2 : (hc.x0 + hc.x1 + 1) / 2, cy: (hc.y0 + hc.y1 + 1) / 2, holeHW: bw / 2, outerW, outerH, conf: Math.min(0.92, conf) });
  }
  // de-duplicate (a merged pair and its halves may all pass)
  out.sort((a, b) => b.conf - a.conf);
  const keep: HollowHead[] = [];
  for (const o of out) {
    if (keep.some((k) => Math.abs(k.cx - o.cx) < 0.5 * d && Math.abs(k.cy - o.cy) < 0.6 * d)) continue;
    keep.push(o);
  }
  return keep;
}

// ---------------------------------------------------------------------------------------------------------------------
// Key signature

export interface Stroke {
  x0: number;
  x1: number;
  top: number;
  bot: number;
}

/** Vertical strokes (thin, tall inked columns) in the x range [xa, xb). Works on the staff-line-free image. */
export function findStrokes(img: GImg, xa: number, xb: number, ya: number, yb: number, minLen: number, maxW: number): Stroke[] {
  const { w, h, d } = img;
  const cols: ({ top: number; bot: number } | null)[] = [];
  for (let x = Math.max(0, xa); x < Math.min(w, xb); x++) {
    let best: { top: number; bot: number } | null = null;
    let y = Math.max(0, ya);
    const yEnd = Math.min(h - 1, yb);
    while (y <= yEnd) {
      if (!d[y * w + x]) {
        y++;
        continue;
      }
      const s = y;
      let miss = 0;
      let last = y;
      while (y <= yEnd + 1 && y < h) {
        if (d[y * w + x]) {
          last = y;
          miss = 0;
        } else if (++miss > 1) break;
        y++;
      }
      if (last - s + 1 >= minLen && (!best || last - s > best.bot - best.top)) best = { top: s, bot: last };
    }
    cols.push(best);
  }
  const strokes: Stroke[] = [];
  let cur: Stroke | null = null;
  const overlaps = (a: { top: number; bot: number }, b: { top: number; bot: number }): boolean => {
    const ov = Math.min(a.bot, b.bot) - Math.max(a.top, b.top) + 1;
    return ov >= 0.6 * Math.min(a.bot - a.top + 1, b.bot - b.top + 1);
  };
  for (let i = 0; i <= cols.length; i++) {
    const c = i < cols.length ? cols[i] : null;
    const x = Math.max(0, xa) + i;
    if (c && cur && overlaps(c, cur)) {
      cur.x1 = x;
      cur.top = Math.min(cur.top, c.top);
      cur.bot = Math.max(cur.bot, c.bot);
    } else {
      if (cur && cur.x1 - cur.x0 + 1 <= maxW) strokes.push(cur);
      cur = c ? { x0: x, x1: x, top: c.top, bot: c.bot } : null;
    }
  }
  return strokes;
}

function rowFrac(img: GImg, xa: number, xb: number, ya: number, yb: number): number {
  const { w, h, d } = img;
  const y0 = Math.max(0, Math.round(ya));
  const y1 = Math.min(h - 1, Math.round(yb));
  if (y1 < y0) return 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = Math.max(0, Math.round(xa)); x <= Math.min(w - 1, Math.round(xb)); x++) {
      if (d[y * w + x]) {
        n++;
        break;
      }
    }
  }
  return n / (y1 - y0 + 1);
}

export interface KeyRead {
  fifths: number;
  /** right edge of the last accidental (local x), or `startX` when none */
  endX: number;
}

/**
 * Read a key signature from the staff-line-free image. Accidentals are located through their vertical strokes:
 *  flat  = single stroke with a bulb on the lower right and nothing to its left / upper right
 *  sharp = pair of strokes < 0.75 staff spaces apart
 * Sequence rules: first glyph within 4.5 spaces of the clef, later glyphs within 2.6 spaces of their predecessor,
 * all of the same kind, at most 7.
 */
export function readKeySignature(img: GImg, d: number, topL: number, botL: number, startX: number): KeyRead {
  const ya = Math.round(topL - 2.6 * d);
  const yb = Math.round(botL + 2.6 * d);
  const strokes = findStrokes(img, Math.round(startX), Math.round(startX + 22 * d), ya, yb, Math.round(2.0 * d), Math.max(3, Math.round(0.4 * d)));
  type G = { kind: 'flat' | 'sharp'; x0: number; x1: number; s: Stroke };
  const glyphs: G[] = [];
  let prevEnd = startX;
  const rightEdge = (g: G): number => {
    let endX = g.x1;
    const lim = Math.min(img.w - 1, Math.round(g.x1 + 1.2 * d));
    let gap = 0;
    for (let x = g.x1 + 1; x <= lim; x++) {
      let any = false;
      for (let y = g.s.top; y <= g.s.bot && !any; y++) if (img.d[y * img.w + x]) any = true;
      if (any) {
        endX = x;
        gap = 0;
      } else if (++gap > 1) break;
    }
    return endX;
  };
  let i = 0;
  while (i < strokes.length) {
    const s = strokes[i];
    if (s.x1 <= startX + 1) {
      i++;
      continue;
    }
    const ref = glyphs.length ? glyphs[glyphs.length - 1].x0 : startX;
    if (s.x0 - ref > (glyphs.length ? 2.6 : 4.5) * d) break;
    const len = s.bot - s.top + 1;
    const nxt = strokes[i + 1];
    let g: G | null = null;
    if (nxt && nxt.x0 - s.x1 <= 0.75 * d && Math.abs(nxt.bot - nxt.top + 1 - len) <= 0.3 * len) {
      const between = rowFrac(img, s.x1 + 1, nxt.x0 - 1, s.top + 0.2 * len, s.bot - 0.2 * len);
      const topDiff = Math.abs(nxt.top - s.top);
      if (between >= 0.2 && topDiff < 0.3 * len) g = { kind: 'sharp', x0: s.x0, x1: nxt.x1, s: nxt };
      i += 2;
    } else {
      const leftInk = rowFrac(img, Math.max(s.x0 - 0.55 * d, prevEnd + 1), s.x0 - 2, s.top + 0.35 * len, s.bot - 0.15 * len);
      const bulb = rowFrac(img, s.x1 + 2, s.x1 + 0.85 * d, s.bot - 0.9 * d, s.bot - 1);
      const topRight = rowFrac(img, s.x1 + 2, s.x1 + 0.6 * d, s.top, s.top + 0.3 * len);
      if (bulb >= 0.5 && leftInk <= 0.2 && topRight <= 0.2) g = { kind: 'flat', x0: s.x0, x1: s.x1, s };
      i += 1;
    }
    if (!g) break;
    if (glyphs.length && glyphs[0].kind !== g.kind) break;
    glyphs.push(g);
    prevEnd = rightEdge(g);
    if (glyphs.length >= 7) break;
  }
  if (glyphs.length === 0) return { fifths: 0, endX: startX };
  const endX = prevEnd;
  const n = glyphs.length;
  return { fifths: glyphs[0].kind === 'flat' ? -n : n, endX };
}

// ---------------------------------------------------------------------------------------------------------------------
// Multi-measure rests

export interface MultiRestBar {
  x0: number;
  x1: number;
}

/**
 * Thick horizontal bars centred on the middle staff line (original crop). Staff lines are thinner than
 * `max(1.6 t, 0.4 d)`; a multi-measure rest bar is thicker and at least 2.5 spaces long.
 */
export function findMultiRestBars(img: GImg, d: number, t: number, midY: number, left: number, right: number): MultiRestBar[] {
  const { w, h, d: data } = img;
  const thick = Math.max(Math.ceil(1.6 * t), Math.round(0.4 * d));
  const maxTh = Math.round(1.1 * d);
  const my = Math.round(midY);
  const ok: boolean[] = new Array(w).fill(false);
  for (let x = Math.max(0, Math.floor(left)); x <= Math.min(w - 1, Math.ceil(right)); x++) {
    let up = 0;
    let dn = 0;
    // thickness of the ink band covering the mid line (searching +-2 rows for the band)
    let y0 = -1;
    for (let dy = -2; dy <= 2; dy++) if (my + dy >= 0 && my + dy < h && data[(my + dy) * w + x]) y0 = my + dy;
    if (y0 < 0) continue;
    let y = y0;
    while (y > 0 && data[(y - 1) * w + x]) {
      y--;
      up++;
    }
    y = y0;
    while (y < h - 1 && data[(y + 1) * w + x]) {
      y++;
      dn++;
    }
    const th = up + dn + 1;
    if (th >= thick && th <= maxTh) ok[x] = true;
  }
  const out: MultiRestBar[] = [];
  let x = 0;
  while (x < w) {
    if (!ok[x]) {
      x++;
      continue;
    }
    const s = x;
    let gap = 0;
    let e = x;
    while (x < w && (ok[x] || gap < 2)) {
      if (ok[x]) {
        e = x;
        gap = 0;
      } else gap++;
      x++;
    }
    if (e - s + 1 >= 2.5 * d) out.push({ x0: s, x1: e });
  }
  return out;
}
