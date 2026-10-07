/** Music-theory helpers shared across modules. */
import type { Spelling, KeySignature } from './score';

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function octaveOf(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/** "C4", "F#3", with flats if the key prefers flats. */
export function midiToName(midi: number, preferFlats = false): string {
  const names = preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return `${names[pitchClass(midi)]}${octaveOf(midi)}`;
}

/** Parse "C4", "F#3", "Bb2", "E" (octave defaults to 4) → MIDI. Returns null when invalid. */
export function nameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2}|x)?(-?\d+)?$/.exec(name.trim());
  if (!m) return null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let p = base[m[1].toUpperCase()];
  const acc = m[2] ?? '';
  if (acc === 'x') p += 2;
  else for (const ch of acc) p += ch === '#' ? 1 : -1;
  const oct = m[3] === undefined ? 4 : parseInt(m[3], 10);
  return (oct + 1) * 12 + p;
}

export function spellingToMidi(s: Spelling): number {
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (s.octave + 1) * 12 + base[s.step] + s.alter;
}

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'] as const;

/** Derive a sensible spelling for a MIDI pitch within a key signature. */
export function spellPitch(midi: number, key: KeySignature): Spelling {
  const pc = pitchClass(midi);
  const octave = octaveOf(midi);
  const preferFlats = key.fifths < 0;
  const natural: Record<number, Spelling['step']> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
  if (natural[pc] !== undefined) {
    const step = natural[pc];
    // In sharp keys F# etc. are diatonic; a natural pitch class may be spelled as such anyway.
    return { step, alter: 0, octave };
  }
  // Accidental pitch classes
  if (preferFlats) {
    const stepsFlat: Record<number, Spelling['step']> = { 1: 'D', 3: 'E', 6: 'G', 8: 'A', 10: 'B' };
    const step = stepsFlat[pc];
    return { step, alter: -1, octave: step === 'C' ? octave + 1 : octave };
  }
  const stepsSharp: Record<number, Spelling['step']> = { 1: 'C', 3: 'D', 6: 'F', 8: 'G', 10: 'A' };
  return { step: stepsSharp[pc], alter: 1, octave };
}

export function keyName(key: KeySignature): string {
  const majors = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const minors = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const i = key.fifths + 7;
  return key.mode === 'minor' ? `${minors[i]} minor` : `${majors[i]} major`;
}

export { SHARP_ORDER, FLAT_ORDER };

/** Duration in ticks → note value name ('quarter', 'eighth', ...) plus dots, best effort. */
export interface NoteValue {
  /** 1 = whole, 2 = half, 4 = quarter, 8, 16, 32, 64 */
  base: number;
  dots: number;
  /** true when the duration is a triplet subdivision */
  triplet: boolean;
}

export function ticksToNoteValue(ticks: number, ppq: number): NoteValue {
  const whole = ppq * 4;
  const candidates: { v: NoteValue; t: number }[] = [];
  for (const base of [1, 2, 4, 8, 16, 32, 64]) {
    const plain = whole / base;
    candidates.push({ v: { base, dots: 0, triplet: false }, t: plain });
    candidates.push({ v: { base, dots: 1, triplet: false }, t: plain * 1.5 });
    candidates.push({ v: { base, dots: 2, triplet: false }, t: plain * 1.75 });
    candidates.push({ v: { base, dots: 0, triplet: true }, t: (plain * 2) / 3 });
  }
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c.t - ticks) < Math.abs(best.t - ticks)) best = c;
  return best.v;
}

export function noteValueToTicks(v: NoteValue, ppq: number): number {
  let t = (ppq * 4) / v.base;
  if (v.triplet) t = (t * 2) / 3;
  let add = t;
  for (let i = 0; i < v.dots; i++) {
    add /= 2;
    t += add;
  }
  return Math.round(t);
}
