/** Synthetic engraving helpers: draw staves/notes into an RGBA buffer (pure JS, no DOM). */
// ------------------------------------------------------------------------------------------------
// Synthetic engraving (pure JS; RGBA Uint8ClampedArray)

export class Canvas {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }
  set(x: number, y: number, ink = true) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const v = ink ? 0 : 255;
    const i = (y * this.width + x) * 4;
    this.data[i] = this.data[i + 1] = this.data[i + 2] = v;
    this.data[i + 3] = 255;
  }
  rect(x0: number, y0: number, x1: number, y1: number, ink = true) {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) this.set(x, y, ink);
  }
  ellipse(cx: number, cy: number, a: number, b: number, ink = true) {
    for (let y = Math.floor(cy - b); y <= Math.ceil(cy + b); y++)
      for (let x = Math.floor(cx - a); x <= Math.ceil(cx + a); x++) {
        const dx = (x - cx) / a;
        const dy = (y - cy) / b;
        if (dx * dx + dy * dy <= 1) this.set(x, y, ink);
      }
  }
  line(x0: number, y0: number, x1: number, y1: number, thick: number) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) * 2;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      this.rect(x, y - thick / 2, x, y + thick / 2);
    }
  }
  img() {
    return { width: this.width, height: this.height, data: this.data };
  }
}

export const TOP = 100; // top line first row; lines are 2 rows thick (TOP..TOP+1), pitch 10
export const lineC = (i: number) => TOP + 0.5 + 10 * i; // centre of line i
/** y centre for a diatonic step from the middle line (positive = up) */
export const yStep = (step: number) => lineC(2) - step * 5;

export function staff(c: Canvas, x0 = 40, x1 = 580, top = TOP) {
  for (let i = 0; i < 5; i++) c.rect(x0, top + 10 * i, x1, top + 10 * i + 1);
}
export function barline(c: Canvas, x: number, top = TOP) {
  c.rect(x, top, x + 1, top + 41);
}
export function ledger(c: Canvas, cx: number, y: number) {
  c.rect(cx - 10, y - 1, cx + 10, y);
}
export function filledHead(c: Canvas, cx: number, step: number, stem: 'up' | 'down' | 'none' = 'up', len = 35) {
  const cy = yStep(step);
  c.ellipse(cx, cy, 6.5, 5);
  if (stem === 'up') c.rect(cx + 5, cy - len, cx + 6, cy);
  if (stem === 'down') c.rect(cx - 6, cy, cx - 5, cy + len);
}
export function hollowHead(c: Canvas, cx: number, step: number, stem: 'up' | 'down' | 'none', keepLine = false) {
  const cy = yStep(step);
  c.ellipse(cx, cy, 6.5, 5);
  c.ellipse(cx, cy, 4.5, 2.8, false);
  if (keepLine) {
    for (let i = 0; i < 5; i++) if (Math.abs(lineC(i) - cy) < 4) c.rect(cx - 5, lineC(i) - 0.5, cx + 5, lineC(i) + 0.5);
  }
  if (stem === 'up') c.rect(cx + 5, cy - 35, cx + 6, cy);
  if (stem === 'down') c.rect(cx - 6, cy, cx - 5, cy + 35);
}
export function sharp(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 14, x + 1, cy + 14);
  c.rect(x + 7, cy - 14, x + 8, cy + 14);
  c.line(x - 1, cy + 4, x + 9, cy - 4, 3);
  c.line(x - 1, cy + 9, x + 9, cy + 1, 3);
}
export function trebleClef(c: Canvas, x: number) {
  c.rect(x + 6, 80, x + 8, 165);
  c.ellipse(x + 7, 132, 8, 12);
  c.ellipse(x + 7, 132, 5, 9, false);
  c.rect(x + 6, 80, x + 8, 165);
  c.ellipse(x + 7, 160, 4, 4);
}

