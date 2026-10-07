import type { Binary, PageTransform, RawImage } from './types';
import { detectStaves } from './staves';

/** RGBA → 8-bit gray (Rec. 601 luma). Transparent pixels count as white. */
export function toGray(img: RawImage): Uint8Array {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const g = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (data[p + 3] === 255) {
      out[i] = Math.round(g);
      continue;
    }
    const a = data[p + 3] / 255;
    out[i] = Math.round(g * a + 255 * (1 - a));
  }
  return out;
}

/** Otsu threshold over a gray image. Returns t: pixels <= t are ink. */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/**
 * Background estimate (paper brightness incl. tint, vignette and gradients). Block means on an 8px grid, a grey-level
 * dilation (ink is darker than paper, so max removes thin strokes) and a smoothing box filter, bilinearly sampled back
 * to full resolution. Runs on a tiny grid, so it costs a few ms even for 300 dpi pages.
 */
export function estimateBackground(gray: Uint8Array, width: number, height: number): Float32Array {
  const B = 8;
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  let grid: Float32Array = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = by * B;
    const y1 = Math.min(height, y0 + B);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * B;
      const x1 = Math.min(width, x0 + B);
      // every other pixel is plenty for a background estimate
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += gray[y * width + x]; cnt++; }
      grid[by * bw + bx] = sum / cnt;
    }
  }
  const R = 2;
  const pass = (src: Float32Array, horizontal: boolean, op: 'max' | 'mean'): Float32Array => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = op === 'max' ? 0 : 0;
        let n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const v = src[yy * bw + xx];
          if (op === 'max') {
            if (v > acc) acc = v;
          } else acc += v;
          n++;
        }
        out[y * bw + x] = op === 'max' ? acc : acc / n;
      }
    }
    return out;
  };
  grid = pass(pass(grid, true, 'max'), false, 'max');
  grid = pass(pass(grid, true, 'mean'), false, 'mean');
  grid = pass(pass(grid, true, 'mean'), false, 'mean');
  const bg = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const fx = gx - x0;
      const top = grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx;
      const bot = grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx;
      bg[y * width + x] = top * (1 - fy) + bot * fy;
    }
  }
  return bg;
}

/** (2R+1)^2 box mean (separable running sums, edges clamp). */
function boxMean(src: Uint8Array, width: number, height: number, R: number): Uint8Array {
  const n = 2 * R + 1;
  const tmp = new Uint16Array(src.length);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let sum = 0;
    for (let k = -R; k <= R; k++) sum += src[o + Math.min(width - 1, Math.max(0, k))];
    for (let x = 0; x < width; x++) {
      tmp[o + x] = Math.round(sum / n);
      sum += src[o + Math.min(width - 1, x + R + 1)] - src[o + Math.max(0, x - R)];
    }
  }
  const out = new Uint8Array(src.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -R; k <= R; k++) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.round(sum / n);
      sum += tmp[Math.min(height - 1, y + R + 1) * width + x] - tmp[Math.max(0, y - R) * width + x];
    }
  }
  return out;
}

/** 3x3 box blur (integer, separable). */
function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
  const tmp = new Uint16Array(src.length);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const l = src[o + (x > 0 ? x - 1 : 0)];
      const r = src[o + (x < width - 1 ? x + 1 : x)];
      tmp[o + x] = l + src[o + x] + r;
    }
  }
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const ou = (y > 0 ? y - 1 : 0) * width;
    const od = (y < height - 1 ? y + 1 : y) * width;
    const o = y * width;
    for (let x = 0; x < width; x++) out[o + x] = Math.round((tmp[ou + x] + tmp[o + x] + tmp[od + x]) / 9);
  }
  return out;
}

/** Pixel noise std-dev (grey levels) from horizontal neighbour differences on paper-like pixels. 0 for clean renders. */
function estimatePaperNoise(norm: Uint8Array, width: number, height: number): number {
  const hist = new Float64Array(256);
  let n = 0;
  const rowStep = Math.max(1, Math.floor(height / 400));
  for (let y = 0; y < height; y += rowStep) {
    const o = y * width;
    for (let x = 1; x < width; x++) {
      const a = norm[o + x - 1];
      const c = norm[o + x];
      if (a < 217 || c < 217) continue;
      hist[Math.abs(a - c)]++;
      n++;
    }
  }
  if (n < 1000) return 0;
  let acc = 0;
  for (let d = 0; d < 256; d++) {
    acc += hist[d];
    if (acc >= n / 2) return (d + 0.5) / (0.6745 * Math.SQRT2) * (d === 0 ? 0.5 : 1);
  }
  return 0;
}

/** Background-normalised page (255 = paper) plus what we learned about its noise. */
export interface NormalizedPage {
  width: number;
  height: number;
  /** 0..255, 255 = paper. For noisy scans this has already been smoothed 3x3. */
  norm: Uint8Array;
  /** Noisy scans only: the 3x3-smoothed page before unsharp masking (a softer alternative to `norm`). */
  soft?: Uint8Array;
  /** Paper noise std-dev in grey levels (before smoothing). */
  sigma: number;
  noisy: boolean;
  /** True when the page has almost no contrast (blank). */
  blank: boolean;
}

/** Grayscale → divide out paper tint / shading → (for noisy scans) 3x3 smooth. */
export function normalizePage(img: RawImage): NormalizedPage {
  const { width, height } = img;
  const gray = toGray(img);
  let min = 255;
  let max = 0;
  for (let i = 0; i < gray.length; i += 7) {
    if (gray[i] < min) min = gray[i];
    if (gray[i] > max) max = gray[i];
  }
  if (max - min < 40) return { width, height, norm: new Uint8Array(gray.length).fill(255), sigma: 0, noisy: false, blank: true };

  let bg: Float32Array | null = estimateBackground(gray, width, height); // released (set to null) once norm is final
  let norm: Uint8Array = new Uint8Array(gray.length);
  const fill = (snap: boolean) => {
    let gmax = 0;
    const bgv = bg!;
    for (let i = 0; i < bgv.length; i += 5) if (bgv[i] > gmax) gmax = bgv[i];
    for (let i = 0; i < gray.length; i++) {
      let b = bgv[i] < 40 ? 40 : bgv[i];
      // Clean renders: where the paper is within 10% of the brightest paper, treat it as flat so pixel values (and
      // hence the Otsu cut) match the plain grayscale path exactly; only real shading/tint gets divided out.
      if (snap && b >= 0.9 * gmax) b = gmax;
      const v = (gray[i] * 255) / b;
      norm[i] = v >= 255 ? 255 : (v + 0.5) | 0;
    }
  };
  fill(false);
  const sigma = estimatePaperNoise(norm, width, height);
  const noisy = sigma >= 2;
  let soft: Uint8Array | undefined;
  if (noisy) {
    norm = boxBlur3(norm, width, height);
    soft = norm;
    norm = new Uint8Array(norm);
    // Unsharp mask: undoes scan blur so staff lines come back to 1-2px and the gaps between them to paper level
    const bl = boxMean(norm, width, height, UNSHARP_RADIUS);
    for (let i = 0; i < norm.length; i++) {
      const v = norm[i] + UNSHARP_AMOUNT * (norm[i] - bl[i]);
      norm[i] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
  }
  else fill(true);
  bg = null;
  return { width, height, norm, soft, sigma, noisy, blank: false };
}

/**
 * Normalised page → binary (1 = ink).
 * - Clean renders: Otsu (as before).
 * - Noisy/blurred scans: threshold raised towards the paper noise floor (capped), plus faint-line rescue and despeckle.
 */
export function thresholdPage(p: NormalizedPage, rescue = true, cap = NOISY_CAP): Binary {
  const { width, height, norm, sigma, noisy } = p;
  const out = new Uint8Array(norm.length);
  if (p.blank) return { width, height, data: out };
  let t = otsuThreshold(norm);
  if (noisy) t = Math.max(t, Math.min(255 - 4 * (sigma / 3), cap));
  else if (t >= 254) t = 253;
  for (let i = 0; i < norm.length; i++) out[i] = norm[i] <= t ? 1 : 0;
  if (rescue && noisy) rescueFaintLines(norm, out, width, height);
  if (noisy) despeckle(out, width, height);
  return { width, height, data: out };
}

/** Grayscale + background normalisation + threshold → binary image where 1 = ink. No deskew. */
export function binarize(img: RawImage): Binary {
  return thresholdPage(normalizePage(img));
}

/** Upper bound for the ink threshold on noisy scans (0..255, relative to paper = 255). */
const NOISY_CAP = 150;
/** Unsharp mask on noisy scans (5x5 box, strong amount): measured best of a grid on the degraded corpus. */
const UNSHARP_RADIUS = 2;
const UNSHARP_AMOUNT = 5;

/**
 * Faint horizontal line recovery. A 1px staff line that was blurred or anti-aliased can sit only 10-20% below the paper
 * level, i.e. within a few sigma of paper noise, so no global threshold keeps it without also speckling the gaps. A
 * long horizontal average (13px) cuts the noise ~4x while leaving a straight line intact: rows that are a vertical
 * minimum of that average, clearly darker than rows 3px above/below, and that stay so for >= 30px are marked as ink.
 */
function rescueFaintLines(norm: Uint8Array, out: Uint8Array, width: number, height: number): void {
  const W = 13;
  const half = W >> 1;
  if (width < 4 * W || height < 8) return;
  const H = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let sum = 0;
    for (let x = 0; x < W; x++) sum += norm[o + x];
    for (let x = 0; x < width; x++) {
      if (x >= half && x + half < width) {
        H[o + x] = Math.round(sum / W);
        if (x + half + 1 < width) sum += norm[o + x + half + 1] - norm[o + x - half];
      } else H[o + x] = 255;
    }
  }
  const MIN_RUN = 30;
  const MAX_GAP = 3;
  for (let y = 3; y < height - 3; y++) {
    const o = y * width;
    let runStart = -1;
    let lastOn = -10;
    const flush = (end: number) => {
      if (runStart >= 0 && end - runStart + 1 >= MIN_RUN) for (let x = runStart; x <= end; x++) {
          // do not thicken a line that is already (partly) ink
          if (!out[o + x] && !out[o - width + x] && !out[o + width + x]) out[o + x] = 1;
        }
      runStart = -1;
    };
    for (let x = 0; x < width; x++) {
      const h = H[o + x];
      let on = false;
      if (h < 240) {
        const up = H[o - 3 * width + x];
        const dn = H[o + 3 * width + x];
        on =
          up - h >= 6 && dn - h >= 6 &&
          h <= H[o - width + x] && h <= H[o + width + x] &&
          h <= H[o - 2 * width + x] && h <= H[o + 2 * width + x];
      }
      if (on) {
        if (runStart < 0) runStart = x;
        lastOn = x;
      } else if (runStart >= 0 && x - lastOn > MAX_GAP) flush(lastOn);
    }
    flush(lastOn);
  }
}

/** Remove ink pixels that have no 8-neighbour ink pixel (paper grain). */
function despeckle(data: Uint8Array, width: number, height: number): void {
  for (let y = 1; y < height - 1; y++) {
    const o = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (!data[o + x]) continue;
      const n =
        data[o + x - 1] + data[o + x + 1] +
        data[o - width + x - 1] + data[o - width + x] + data[o - width + x + 1] +
        data[o + width + x - 1] + data[o + width + x] + data[o + width + x + 1];
      if (n === 0) data[o + x] = 0;
    }
  }
}

/** Nearest-neighbour downscale of an RGBA image so the longest side <= maxSide. */
export function downscale(img: RawImage, maxSide = 2500): { image: RawImage; scale: number } {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxSide) return { image: img, scale: 1 };
  const scale = maxSide / longest;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  // Box average for quality (thin staff lines survive)
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.floor((x + 1) / scale)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const p = (yy * img.width + xx) * 4;
          r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; a += img.data[p + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { image: { width: w, height: h, data: out }, scale };
}

function projectionScore(b: Binary, angle: number, pts: Int32Array): number {
  const { width, height } = b;
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pad = Math.ceil(Math.abs(Math.sin(angle)) * width) + 2;
  const bins = new Float64Array(height + 2 * pad);
  let n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] - cx;
    const y = pts[i + 1] - cy;
    const yr = Math.round(-x * sin + y * cos + cy) + pad;
    bins[yr]++;
    n++;
  }
  if (n === 0) return 0;
  // Peakiness: sum of squares (equivalent to variance for fixed mass)
  let s = 0;
  for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
  return s;
}

/** Projection-profile skew search over +-3 degrees (0.5 deg coarse, 0.1 deg fine, parabolic refinement). Returns radians. */
export function estimateSkew(b: Binary): number {
  const { width, height, data } = b;
  // Subsample ink pixels for speed
  let count = 0;
  for (let i = 0; i < data.length; i++) count += data[i];
  if (count < 200) return 0;
  const stride = Math.max(1, Math.floor(count / 250000));
  const pts = new Int32Array(Math.ceil(count / stride) * 2 + 2);
  let k = 0;
  let seen = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]) {
        if (seen % stride === 0) {
          pts[k++] = x;
          pts[k++] = y;
        }
        seen++;
      }
    }
  }
  const sub = pts.subarray(0, k);
  const rad = Math.PI / 180;
  const base = projectionScore(b, 0, sub);
  // coarse pass over +-3 deg, fine pass around the winner, then a parabola through the three best samples
  let bestA = 0;
  let best = base;
  for (let a = -3; a <= 3.0001; a += 0.5) {
    if (Math.abs(a) < 1e-9) continue;
    const s = projectionScore(b, a * rad, sub);
    if (s > best) {
      best = s;
      bestA = a;
    }
  }
  const lo = bestA - 0.5;
  let fineA = bestA;
  let fineS = best;
  const scores = new Map<number, number>();
  for (let i = 0; i <= 10; i++) {
    const a = Math.round((lo + i * 0.1) * 10) / 10;
    const s = Math.abs(a) < 1e-9 ? base : projectionScore(b, a * rad, sub);
    scores.set(a, s);
    if (s > fineS) {
      fineS = s;
      fineA = a;
    }
  }
  if (fineA === 0 || fineS <= base * 1.02) return 0;
  const sm = scores.get(Math.round((fineA - 0.1) * 10) / 10);
  const sp = scores.get(Math.round((fineA + 0.1) * 10) / 10);
  let refined = fineA;
  if (sm !== undefined && sp !== undefined) {
    const den = sm - 2 * fineS + sp;
    if (den < 0) refined = fineA + (0.1 * 0.5 * (sm - sp)) / den;
  }
  return refined * rad;
}

/**
 * Rotate a binary image by `angle` (same convention as estimateSkew: a pixel (x,y) moves to y' = -x sin + y cos)
 * so that rows become horizontal. Output has the same dimensions.
 */
export function rotateBinary(b: Binary, angle: number): Binary {
  const { width, height, data } = b;
  const out = new Uint8Array(data.length);
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // forward F: (x,y)->(x cos + y sin, -x sin + y cos); sample the source at F^-1(x',y')
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xr = x - cx;
      const yr = y - cy;
      const sx = Math.round(xr * cos - yr * sin + cx);
      const sy = Math.round(xr * sin + yr * cos + cy);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) out[y * width + x] = data[sy * width + sx];
    }
  }
  return { width, height, data: out };
}

export interface Preprocessed {
  binary: Binary;
  /** Noisy scans only: lightly smoothed grey page (same coordinates as `binary`) for chord-text OCR. */
  grey?: Uint8Array;
  transform: PageTransform;
}

/** Rotate a grey image like rotateBinary (bilinear, paper-white fill). */
function rotateNorm(src: Uint8Array, width: number, height: number, angle: number): Uint8Array {
  const out = new Uint8Array(src.length).fill(255);
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let y = 0; y < height; y++) {
    const yr = y - cy;
    for (let x = 0; x < width; x++) {
      const xr = x - cx;
      const sx = xr * cos - yr * sin + cx;
      const sy = xr * sin + yr * cos + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * width + x0;
      out[y * width + x] = Math.round(
        src[i] * (1 - fx) * (1 - fy) + src[i + 1] * fx * (1 - fy) + src[i + width] * (1 - fx) * fy + src[i + width + 1] * fx * fy,
      );
    }
  }
  return out;
}

/**
 * Final threshold. Noisy scans always get the faint-line rescue. On clean renders Otsu normally keeps every staff line,
 * but anti-aliased hairlines can fall under it (dense Lieder engravings at 150 dpi lose 1-4 staves per page); the rescue
 * variant is only used there when it finds strictly more staves, so pages that already work stay byte-identical.
 */
function finalBinary(page: NormalizedPage, cleanPlain?: Binary): Binary {
  if (page.blank) return thresholdPage(page);
  if (page.noisy) {
    // Sharpened page first (thin lines, solid heads); fall back to the softer page if it finds fewer staves, which
    // happens on very blurry or noisy scans where the unsharp mask amplifies grain more than it recovers lines.
    const sharp = thresholdPage(page);
    if (!page.soft) return sharp;
    const soft = thresholdPage({ ...page, norm: page.soft }, true, 225);
    return detectStaves(soft).length > detectStaves(sharp).length ? soft : sharp;
  }
  // `cleanPlain`: the preliminary binary of an unrotated clean page is exactly this threshold, so it is reused
  const plain = cleanPlain ?? thresholdPage(page, false);
  const withLines = withRescue(page, plain);
  return detectStaves(withLines).length > detectStaves(plain).length ? withLines : plain;
}

function withRescue(page: NormalizedPage, plain: Binary): Binary {
  const data = new Uint8Array(plain.data);
  rescueFaintLines(page.norm, data, page.width, page.height);
  return { width: page.width, height: page.height, data };
}

/**
 * Full preprocessing: downscale → normalise → (preliminary binary →) skew estimate → rotate the grey page (bilinear, so
 * thin lines keep their strength) → final threshold.
 */
export function preprocess(img: RawImage, maxSide = 2500): Preprocessed {
  const { image, scale } = downscale(img, maxSide);
  const page = normalizePage(image);
  let binary = thresholdPage(page.soft ? { ...page, norm: page.soft } : page, false, 225);
  let grey: Uint8Array | undefined = page.noisy && !page.blank ? page.soft : undefined;
  let angle = estimateSkew(binary);
  // Resampling costs a little line quality, so ignore sub-0.1 degree skew
  if (Math.abs(angle) <= (0.1 * Math.PI) / 180) angle = 0;
  if (angle !== 0 && !page.blank) {
    const rot = (a: Uint8Array) => rotateNorm(a, page.width, page.height, angle);
    const soft = page.soft && rot(page.soft);
    binary = finalBinary({ ...page, norm: rot(page.norm), soft });
    if (grey) grey = soft;
  } else {
    angle = 0;
    binary = finalBinary(page, page.blank || page.noisy ? undefined : binary);
  }
  return {
    binary,
    grey,
    transform: {
      scale,
      angle,
      cx: binary.width / 2,
      cy: binary.height / 2,
      originalWidth: img.width,
      originalHeight: img.height,
    },
  };
}

/** Inverse of {@link toOriginal}: original page pixels → processed (scaled + deskewed) coordinates. */
export function fromOriginal(t: PageTransform, x: number, y: number): { x: number; y: number } {
  const px = x * t.scale;
  const py = y * t.scale;
  if (t.angle === 0) return { x: px, y: py };
  const xr = px - t.cx;
  const yr = py - t.cy;
  return {
    x: xr * Math.cos(t.angle) + yr * Math.sin(t.angle) + t.cx,
    y: -xr * Math.sin(t.angle) + yr * Math.cos(t.angle) + t.cy,
  };
}

/** Map a point from processed (scaled + deskewed) coordinates back to original page pixels. */
export function toOriginal(t: PageTransform, x: number, y: number): { x: number; y: number } {
  let px = x;
  let py = y;
  if (t.angle !== 0) {
    const xr = x - t.cx;
    const yr = y - t.cy;
    // processed→source is F^-1
    px = xr * Math.cos(t.angle) - yr * Math.sin(t.angle) + t.cx;
    py = xr * Math.sin(t.angle) + yr * Math.cos(t.angle) + t.cy;
  }
  return { x: px / t.scale, y: py / t.scale };
}
