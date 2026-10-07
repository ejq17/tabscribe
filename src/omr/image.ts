/** Decode an image file (PNG/JPEG/WebP/...) into a canvas. Touches the DOM. */
export async function imageToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  let source: CanvasImageSource & { width: number; height: number };
  let cleanup: (() => void) | undefined;
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      source = bmp;
      cleanup = () => bmp.close();
    } catch {
      source = await loadViaImg(file);
    }
  } else {
    source = await loadViaImg(file);
  }
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is not available');
  // White background so transparent PNG scans binarize correctly
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  cleanup?.();
  return canvas;
}

function loadViaImg(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image'));
    };
    img.src = url;
  });
}
