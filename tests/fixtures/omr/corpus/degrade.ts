/**
 * Pure-TS "book scan" degradation for OMR robustness tests. No dependencies.
 *
 * Simulates, in order: slight page rotation, a small blur, a grey/yellowed paper tint with a
 * gentle vignette, and sensor noise. Deterministic for a given seed, so tests are reproducible.
 */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface DegradeOptions {
  /** Rotation in degrees. Default: seeded pick in [0.3, 1.0] with a random sign. */
  angleDeg?: number
  /** Std-dev of the noise in 0-255 grey levels. Default 9. */
  noiseSigma?: number
  /** Paper colour the white background is multiplied towards. Default [228, 224, 214]. */
  paper?: [number, number, number]
  /** Blur radius in pixels (box blur, 2 passes ~ gaussian). Default 1. 0 disables. */
  blurRadius?: number
  /** PRNG seed. Default 1. */
  seed?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Approximate standard normal: sum of 4 uniforms (Irwin-Hall), scaled to unit variance. */
function gaussian(rand: () => number): number {
  return (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3)
}

function rotate(src: RgbaImage, angleDeg: number, fill: [number, number, number]): Float32Array {
  const { width: w, height: h } = src
  const out = new Float32Array(w * h * 4)
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // inverse map destination -> source
      const dx = x - cx
      const dy = y - cy
      const sx = cos * dx + sin * dy + cx
      const sy = -sin * dx + cos * dy + cy
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
        out[o] = fill[0]
        out[o + 1] = fill[1]
        out[o + 2] = fill[2]
        out[o + 3] = 255
        continue
      }
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(x0 + 1, w - 1)
      const y1 = Math.min(y0 + 1, h - 1)
      const fx = sx - x0
      const fy = sy - y0
      for (let c = 0; c < 3; c++) {
        const p00 = src.data[(y0 * w + x0) * 4 + c]
        const p10 = src.data[(y0 * w + x1) * 4 + c]
        const p01 = src.data[(y1 * w + x0) * 4 + c]
        const p11 = src.data[(y1 * w + x1) * 4 + c]
        out[o + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy
      }
      out[o + 3] = 255
    }
  }
  return out
}

function boxBlur(buf: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) return
  const tmp = new Float32Array(buf.length)
  const n = 2 * r + 1
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += buf[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c]
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = sum / n
        const add = Math.min(w - 1, x + r + 1)
        const sub = Math.max(0, x - r)
        sum += buf[(y * w + add) * 4 + c] - buf[(y * w + sub) * 4 + c]
      }
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c]
      for (let y = 0; y < h; y++) {
        buf[(y * w + x) * 4 + c] = sum / n
        const add = Math.min(h - 1, y + r + 1)
        const sub = Math.max(0, y - r)
        sum += tmp[(add * w + x) * 4 + c] - tmp[(sub * w + x) * 4 + c]
      }
    }
  }
}

export function degradeScan(src: RgbaImage, opts: DegradeOptions = {}): RgbaImage {
  const { width: w, height: h } = src
  const rand = mulberry32(opts.seed ?? 1)
  const angle = opts.angleDeg ?? (0.3 + rand() * 0.7) * (rand() < 0.5 ? -1 : 1)
  const sigma = opts.noiseSigma ?? 9
  const paper = opts.paper ?? [228, 224, 214]
  const blur = opts.blurRadius ?? 1

  const buf = rotate(src, angle, [255, 255, 255])
  boxBlur(buf, w, h, blur)
  if (blur > 0) boxBlur(buf, w, h, blur)

  const data = new Uint8ClampedArray(w * h * 4)
  const cx = w / 2
  const cy = h / 2
  const maxD = Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      // vignette: up to ~8% darker at the corners
      const v = 1 - 0.08 * (Math.hypot(x - cx, y - cy) / maxD) ** 2
      const n = gaussian(rand) * sigma // same noise on all channels, like luminance grain
      for (let c = 0; c < 3; c++) {
        data[o + c] = (buf[o + c] / 255) * paper[c] * v + n
      }
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data }
}
