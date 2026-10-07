import { DEFAULT_PPQ, newNoteId } from '../core';
import type { Note, Score } from '../core';

export { DEFAULT_PPQ };

export function makeNote(
  pitch: number,
  start: number,
  duration: number,
  velocity = 90,
  voice = 0,
  extra: Partial<Note> = {},
): Note {
  return { id: newNoteId(), pitch, start, duration, velocity, voice, ...extra };
}

export function addWarning(score: Score, msg: string): void {
  if (!score.meta.warnings) score.meta.warnings = [];
  if (!score.meta.warnings.includes(msg)) score.meta.warnings.push(msg);
}

/** Circle-of-fifths position for a key name like "G", "Bb", "F#" (major or minor). */
export function keyNameToFifths(name: string, mode: 'major' | 'minor'): number {
  const majors = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const minors = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const n = name.trim();
  const norm = n.length ? n[0].toUpperCase() + n.slice(1) : n;
  const idx = (mode === 'minor' ? minors : majors).indexOf(norm);
  return idx < 0 ? 0 : idx - 7;
}

export function baseName(filename: string): string {
  const b = filename.split(/[\\/]/).pop() ?? filename;
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function extOf(filename: string): string {
  const b = filename.split(/[\\/]/).pop() ?? filename;
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
}

export function sortScoreMeta(score: Score): void {
  score.tempos.sort((a, b) => a.tick - b.tick);
  score.timeSignatures.sort((a, b) => a.tick - b.tick);
  score.keySignatures.sort((a, b) => a.tick - b.tick);
  for (const t of score.tracks) t.notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
}

const dec = new TextDecoder('utf-8');
export function decodeUtf8(b: Uint8Array): string {
  let s = dec.decode(b);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
