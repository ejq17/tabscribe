/**
 * Renders the chord band of one system from a page canvas as a PNG strip for the Claude reader.
 * The strip shows the system from ~6 staff spaces above the first staff down to ~2 below it, with a thin red tick at each
 * barline (below the staff) and a red measure number (1..N, left to right) under each measure.
 */
import type { OmrSystem } from '../core';

export const MAX_STRIP_WIDTH = 1568;

export interface StripMeasure {
  /** 1-based number printed under the measure in the strip */
  number: number;
  /** absolute 0-based measure index in the score */
  measure: number;
  /** barline x range in page pixels */
  x0: number;
  x1: number;
  tick: number;
  length: number;
  beatTicks: number;
}

export interface Strip {
  /** base64 PNG (no data: prefix) */
  png: string;
  width: number;
  height: number;
  measures: StripMeasure[];
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Optional canvas factory (Node: @napi-rs/canvas). The returned object needs getContext('2d') and either toBuffer('image/png'), convertToBlob or toDataURL. */
export type CanvasFactory = (w: number, h: number) => AnyCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function toPngBase64(c: AnyCanvas): Promise<string> {
  const node = c as unknown as { toBuffer?: (mime: string) => Uint8Array };
  if (typeof node.toBuffer === 'function') return bytesToBase64(new Uint8Array(node.toBuffer('image/png')));
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) {
    const blob = await c.convertToBlob({ type: 'image/png' });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  const url = (c as HTMLCanvasElement).toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}

/** Render the strip for `system` from `page` (the canvas that was given to recognizeScore). */
export async function renderStrip(page: CanvasImageSource & { width: number; height: number }, system: OmrSystem, factory: CanvasFactory = makeCanvas): Promise<Strip | undefined> {
  const d = system.staffSpace > 0 ? system.staffSpace : 10;
  const margin = Math.round(1.5 * d);
  const x0 = Math.max(0, Math.floor(system.left - margin));
  const x1 = Math.min(page.width, Math.ceil(system.right + margin));
  const y0 = Math.max(0, Math.floor(system.staffTop - 6 * d));
  const y1 = Math.min(page.height, Math.ceil(system.staffBottom + 2 * d));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8 || system.cells.length === 0) return undefined;
  const k = Math.min(1, MAX_STRIP_WIDTH / w);
  const outW = Math.max(1, Math.round(w * k));
  const outH = Math.max(1, Math.round(h * k));
  const canvas = factory(outW, outH);
  const ctx = canvas.getContext('2d') as Ctx | null;
  if (!ctx) return undefined;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(page as CanvasImageSource, x0, y0, w, h, 0, 0, outW, outH);

  const red = '#e00000';
  ctx.strokeStyle = red;
  ctx.fillStyle = red;
  ctx.lineWidth = Math.max(1, Math.round(1.2 * k * d * 0.15));
  const fontPx = Math.max(10, Math.round(1.6 * d * k));
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const tickTop = (system.staffBottom - y0) * k;
  const tickBottom = Math.min(outH, tickTop + 1.6 * d * k);
  const tick = (x: number) => {
    const px = Math.round((x - x0) * k) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, tickTop);
    ctx.lineTo(px, tickBottom);
    ctx.stroke();
  };
  const measures: StripMeasure[] = system.cells.map((c, i) => ({
    number: i + 1,
    measure: c.measure,
    x0: c.x0,
    x1: c.x1,
    tick: c.tick,
    length: c.length,
    beatTicks: c.beatTicks,
  }));
  for (const m of measures) {
    tick(m.x0);
    const cx = ((m.x0 + m.x1) / 2 - x0) * k;
    ctx.fillText(String(m.number), Math.max(fontPx / 2, Math.min(outW - fontPx / 2, cx)), Math.min(outH - fontPx - 1, tickTop + 0.2 * d * k));
  }
  tick(measures[measures.length - 1].x1);
  return { png: await toPngBase64(canvas), width: outW, height: outH, measures };
}
