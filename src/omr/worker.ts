/// <reference lib="webworker" />
import { recognizeImageDataWithChords } from './assemble';
import type { RawImage, RecognizeOptions } from './types';

export interface WorkerRequest {
  type: 'recognize';
  pages: { width: number; height: number; buffer: ArrayBuffer }[];
  defaultClef?: RecognizeOptions['defaultClef'];
  instrument?: RecognizeOptions['instrument'];
}

export type WorkerResponse =
  | { type: 'progress'; stage: string; fraction: number; page?: number }
  | { type: 'done'; score: Awaited<ReturnType<typeof recognizeImageDataWithChords>> }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'recognize') return;
  try {
    const pages: RawImage[] = msg.pages.map((p) => ({
      width: p.width,
      height: p.height,
      data: new Uint8ClampedArray(p.buffer),
    }));
    const score = await recognizeImageDataWithChords(pages, {
      defaultClef: msg.defaultClef,
      instrument: msg.instrument,
      onProgress: (p) => ctx.postMessage({ type: 'progress', ...p } satisfies WorkerResponse),
    });
    ctx.postMessage({ type: 'done', score } satisfies WorkerResponse);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies WorkerResponse);
  }
};
