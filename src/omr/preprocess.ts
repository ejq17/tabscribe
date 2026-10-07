import type { Binary, PageTransform, RawImage } from './types';

/** RGBA → 8-bit gray (Rec. 601 luma). Transparent pixels count as white. */
export function toGray(img: RawImage): Uint8Array {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const g = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
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

/** Grayscale + Otsu → binary image where 1 = ink. */
export function binarize(img: RawImage): Binary {
  const gray = toGray(img);
  let t = otsuThreshold(gray);
  // Guard against blank/near-uniform pages: require real contrast
  let min = 255;
  let max = 0;
  for (let i = 0; i < gray.length; i += 7) {
    if (gray[i] < min) min = gray[i];
    if (gray[i] > max) max = gray[i];
  }
  const out = new Uint8Array(gray.length);
  if (max - min < 40) return { width: img.width, height: img.height, data: out };
  if (t >= max) t = max - 1;
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] <= t ? 1 : 0;
  return { width: img.width, height: img.height, data: out };
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

/** Try angles in [-3°, 3°] step 0.25°; return best angle (radians) if it improves peakiness. */
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
  const base = projectionScore(b, 0, sub);
  let best = base;
  let bestAngle = 0;
  for (let a = -3; a <= 3.0001; a += 0.25) {
    if (Math.abs(a) < 1e-9) continue;
    const ang = (a * Math.PI) / 180;
    const s = projectionScore(b, ang, sub);
    if (s > best) {
      best = s;
      bestAngle = ang;
    }
  }
  if (bestAngle !== 0 && best > base * 1.02) return bestAngle;
  return 0;
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
  transform: PageTransform;
}

/** Full preprocessing: downscale → binarize → deskew. */
export function preprocess(img: RawImage, maxSide = 2500): Preprocessed {
  const { image, scale } = downscale(img, maxSide);
  let binary = binarize(image);
  const angle = estimateSkew(binary);
  if (angle !== 0) binary = rotateBinary(binary, angle);
  return {
    binary,
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
