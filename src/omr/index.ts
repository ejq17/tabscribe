// STUB — replaced by the OMR agent. Keep these signatures.
import type { Score } from '../core';
export interface OmrOptions { onProgress?: (p: { stage: string; fraction: number; page?: number }) => void; defaultClef?: 'treble' | 'bass' }
export async function renderPdfPages(_data: ArrayBuffer, _scale?: number): Promise<HTMLCanvasElement[]> { throw new Error('not implemented'); }
export async function imageToCanvas(_file: Blob): Promise<HTMLCanvasElement> { throw new Error('not implemented'); }
export async function recognizeScore(_pages: HTMLCanvasElement[], _opts?: OmrOptions): Promise<Score> { throw new Error('not implemented'); }
