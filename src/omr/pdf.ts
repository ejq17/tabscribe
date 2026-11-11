/**
 * Render PDF pages to canvases with pdf.js. The pdf.js worker is bundled locally via Vite's `?url` import
 * (no CDN), and pdf.js itself is loaded lazily so non-PDF flows and tests never pay for it.
 */
import type { PdfTextItem } from './textlayer';

export interface RenderedPdf {
  canvases: HTMLCanvasElement[];
  /** per page: the PDF text layer in canvas pixels (same scale as the canvas, also after the >4000 px downscale); [] when a page has none */
  textItems: PdfTextItem[][];
}

/** Render pages AND extract the text layer (string + baseline-left position + size, in canvas pixels). */
export async function renderPdfPagesWithText(data: ArrayBuffer, scale = 2.5): Promise<RenderedPdf> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js transfers/detaches the buffer; hand it a copy so the caller's data survives
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  const canvases: HTMLCanvasElement[] = [];
  const textItems: PdfTextItem[][] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      let viewport = page.getViewport({ scale });
      // keep canvases within browser limits
      const longest = Math.max(viewport.width, viewport.height);
      if (longest > 4000) viewport = page.getViewport({ scale: (scale * 4000) / longest });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context is not available');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const items: PdfTextItem[] = [];
      try {
        const tc = await page.getTextContent();
        for (const it of tc.items) {
          if (!('str' in it) || it.str.length === 0) continue;
          const m = pdfjs.Util.transform(viewport.transform, it.transform);
          items.push({ str: it.str, x: m[4], y: m[5], w: it.width * viewport.scale, h: it.height * viewport.scale, font: it.fontName });
        }
      } catch {
        /* no text layer: the page is read from the image only */
      }
      page.cleanup();
      canvases.push(canvas);
      textItems.push(items);
    }
  } finally {
    await task.destroy();
  }
  return { canvases, textItems };
}

export async function renderPdfPages(data: ArrayBuffer, scale = 2.5): Promise<HTMLCanvasElement[]> {
  return (await renderPdfPagesWithText(data, scale)).canvases;
}
