import { describe, it, expect } from 'vitest';
import { binarize, estimateSkew, fromOriginal, preprocess, rotateBinary, toOriginal } from '../src/omr/preprocess';
import { detectStaves } from '../src/omr/staves';
import { degradeScan } from './fixtures/omr/corpus/degrade';
import type { RawImage } from '../src/omr/types';

/** Deterministic PRNG so the tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const D = 11; // staff space in px

/** White RGBA page with `staffTops` staves (1px lines), a notehead + stem per ~60px and a barline every 240px. */
function syntheticPage(w: number, h: number, staffTops: number[]): RawImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dot = (x: number, y: number) => {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 0;
    }
  };
  for (const top of staffTops) {
    for (let i = 0; i < 5; i++) for (let x = 60; x < w - 60; x++) dot(x, top + i * D);
    for (let x = 60; x < w - 60; x += 240) for (let y = top; y <= top + 4 * D; y++) dot(x, y);
    for (let x = 100; x < w - 100; x += 60) {
      const cy = top + 2 * D + ((x / 60) % 3) * (D / 2);
      for (let dy = -4; dy <= 4; dy++) for (let dx = -6; dx <= 6; dx++) if ((dx * dx) / 36 + (dy * dy) / 16 <= 1) dot(x + dx, cy + dy);
      for (let y = cy - 3.5 * D; y < cy; y++) dot(x + 6, Math.round(y));
    }
  }
  return { width: w, height: h, data };
}

describe('binarize: tinted / uneven backgrounds', () => {
  it('keeps staff lines and drops a gradient + noise background', () => {
    const w = 700;
    const h = 160;
    const r = rng(7);
    const data = new Uint8ClampedArray(w * h * 4);
    const lineRows = [40, 51, 62, 73, 84];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // paper darkens left -> right from 250 to 165 and top -> bottom a little; tint towards yellow
        const paper = 250 - (85 * x) / w - (20 * y) / h;
        // lines: 2px wide with soft edges (blurred scan)
        let dark = 0;
        for (const ly of lineRows) {
          const dd = Math.abs(y - (ly + 0.5));
          if (dd < 2.5) dark = Math.max(dark, 1 - dd / 2.5);
        }
        dark *= 0.45; // faint: lines only reach ~55% of paper brightness
        const n = (r() + r() + r() + r() - 2) * 9;
        const v = paper * (1 - dark) + n;
        const o = (y * w + x) * 4;
        data[o] = v;
        data[o + 1] = v * 0.96;
        data[o + 2] = v * 0.88;
        data[o + 3] = 255;
      }
    }
    const b = binarize({ width: w, height: h, data });
    // every staff line row is (almost) fully inked across the page
    for (const ly of lineRows) {
      let ink = 0;
      for (let x = 0; x < w; x++) ink += b.data[ly * w + x] | b.data[(ly + 1) * w + x];
      expect(ink / w).toBeGreaterThan(0.9);
    }
    // the gaps between lines stay clean (specks removed)
    let gapInk = 0;
    let gapN = 0;
    for (const ly of lineRows.slice(0, 4)) {
      const y = ly + 5;
      for (let x = 0; x < w; x++) {
        gapInk += b.data[y * w + x];
        gapN++;
      }
    }
    expect(gapInk / gapN).toBeLessThan(0.02);
    // and the whole page is not drowned in ink (the five lines are ~3px thick here: ~10%)
    let total = 0;
    for (let i = 0; i < b.data.length; i++) total += b.data[i];
    expect(total / b.data.length).toBeLessThan(0.2);
  });

  it('a clean white page still binarizes exactly like a plain threshold', () => {
    const page = syntheticPage(500, 200, [50]);
    const b = binarize(page);
    let ink = 0;
    for (let i = 0; i < b.data.length; i++) ink += b.data[i];
    let expected = 0;
    for (let i = 0; i < page.data.length; i += 4) if (page.data[i] === 0) expected++;
    expect(ink).toBe(expected);
  });
});

describe('deskew and staff detection on degraded scans', () => {
  const clean = syntheticPage(1000, 700, [120, 380]);

  it('detects both staves on the clean page', () => {
    expect(detectStaves(preprocess(clean).binary)).toHaveLength(2);
  });

  it.each([0.8, -0.8, 0.35])('finds the skew angle and both staves when the scan is rotated by %s deg', (angleDeg) => {
    const scan = degradeScan(clean, { angleDeg, seed: 3 }) as unknown as RawImage;
    const pre = preprocess(scan);
    const est = (pre.transform.angle * 180) / Math.PI;
    expect(Math.abs(est - angleDeg)).toBeLessThan(0.15);
    const staves = detectStaves(pre.binary);
    expect(staves).toHaveLength(2);
    // staff lines come out level after deskew
    for (const s of staves) {
      expect(Math.abs(s.bands[0].ys[0] - s.bands[s.bands.length - 1].ys[0])).toBeLessThan(2);
      expect(s.staffSpace).toBeGreaterThan(D - 1);
      expect(s.staffSpace).toBeLessThan(D + 1);
    }
  });

  it('estimateSkew returns about the rotation applied to a clean binary', () => {
    const b = binarize(clean);
    const rot = rotateBinary(b, (1.2 * Math.PI) / 180);
    const est = (estimateSkew(rot) * 180) / Math.PI;
    // rotateBinary(+a) is the correction for a skew of +a, so undoing means estimating -a... either sign convention: magnitude
    expect(Math.abs(Math.abs(est) - 1.2)).toBeLessThan(0.15);
  });

  it('staff detection tolerates a leftover skew of 0.3 deg (no deskew)', () => {
    const b = binarize(clean);
    const tilted = rotateBinary(b, (0.3 * Math.PI) / 180);
    expect(detectStaves(tilted)).toHaveLength(2);
  });

  it('does not rotate a straight page', () => {
    expect(preprocess(clean).transform.angle).toBe(0);
  });
});

describe('PageTransform', () => {
  it('round-trips points through scale + deskew', () => {
    const clean = syntheticPage(1000, 700, [120, 380]);
    const scan = degradeScan(clean, { angleDeg: 0.9, seed: 5 }) as unknown as RawImage;
    // maxSide 500 forces a 0.5 downscale on top of the deskew
    const pre = preprocess(scan, 500);
    expect(pre.transform.scale).toBeCloseTo(0.5, 5);
    expect(pre.transform.angle).not.toBe(0);
    for (const [x, y] of [[10, 20], [500, 350], [990, 690], [123.5, 456.25]]) {
      const p = fromOriginal(pre.transform, x, y);
      const q = toOriginal(pre.transform, p.x, p.y);
      expect(q.x).toBeCloseTo(x, 6);
      expect(q.y).toBeCloseTo(y, 6);
    }
  });

  it('maps a processed-image feature back onto its location in the original scan', () => {
    const clean = syntheticPage(1000, 700, [120, 380]);
    const angleDeg = 1.0;
    const scan = degradeScan(clean, { angleDeg, seed: 9 }) as unknown as RawImage;
    const pre = preprocess(scan);
    const staves = detectStaves(pre.binary);
    expect(staves).toHaveLength(2);
    // the top line of the first staff, at its left end, in original scan pixels: compare with the scan's own dark pixels
    const s = staves[0];
    const x = s.left + 40;
    const y = s.lines[0];
    const o = toOriginal(pre.transform, x, y);
    // look for the line in the (rotated) scan around the mapped point: the darkest pixel in a +-4px column window
    let bestY = -1;
    let best = 1e9;
    for (let yy = Math.round(o.y) - 4; yy <= Math.round(o.y) + 4; yy++) {
      const v = scan.data[(yy * scan.width + Math.round(o.x)) * 4];
      if (v < best) {
        best = v;
        bestY = yy;
      }
    }
    expect(Math.abs(bestY - o.y)).toBeLessThanOrEqual(2);
  });
});
