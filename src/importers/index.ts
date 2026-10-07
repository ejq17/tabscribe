// STUB — replaced by the importers agent. Keep these signatures.
import type { Score } from '../core';
export interface ImportOptions { onProgress?: (p: { stage: string; fraction: number }) => void }
export function importMidi(_data: ArrayBuffer): Score { throw new Error('not implemented'); }
export function importMusicXml(_data: ArrayBuffer | string): Score { throw new Error('not implemented'); }
export function importAbc(_text: string): Score { throw new Error('not implemented'); }
export function importGuitarPro(_data: ArrayBuffer, _filename: string): Score { throw new Error('not implemented'); }
export async function importFile(_file: File, _opts?: ImportOptions): Promise<Score> { throw new Error('not implemented'); }
export const SUPPORTED_EXTENSIONS = ['mid', 'midi', 'xml', 'musicxml', 'mxl', 'abc', 'gp3', 'gp4', 'gp5', 'gpx', 'gp', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'ogg'];
