/**
 * Render PDF pages to canvases with pdf.js. The pdf.js worker is bundled locally via Vite's `?url` import
 * (no CDN), and pdf.js itself is loaded lazily so non-PDF flows and tests never pay for it.
 */
export async function renderPdfPages(data: ArrayBuffer, scale = 2.5): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js transfers/detaches the buffer; hand it a copy so the caller's data survives
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  const out: HTMLCanvasElement[] = [];
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
      page.cleanup();
      out.push(canvas);
    }
  } finally {
    await task.destroy();
  }
  return out;
}
