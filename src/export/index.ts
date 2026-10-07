// STUB — replaced by the tab/chords agent. Keep these signatures.
import type { Score, GuitarConfig } from '../core';
export function exportMidi(_score: Score): Uint8Array { return new Uint8Array(); }
export function exportMusicXml(_score: Score, _guitar: GuitarConfig): string { return ''; }
export function downloadBlob(data: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
