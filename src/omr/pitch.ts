import type { ClefKind, Notehead, Staff } from './types';
import { lineY } from './staves';
import type { Spelling } from '../core';

const LETTERS: Spelling['step'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BASE = [0, 2, 4, 5, 7, 9, 11];
/** letter indices (C=0) in order of sharps / flats */
const SHARP_LETTERS = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_LETTERS = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

/** Diatonic index (octave*7 + letter) of the staff's middle line: B4 for treble, D3 for bass. */
export function middleLineDia(clef: ClefKind): number {
  return clef === 'treble' ? 4 * 7 + 6 : 3 * 7 + 1;
}

/** Diatonic steps from the middle line (positive = up) for a notehead centre. */
export function headStep(staff: Staff, cx: number, cy: number): number {
  const mid = lineY(staff, 2, cx);
  return Math.round((mid - cy) / (staff.staffSpace / 2));
}

/** Per-letter alteration implied by a key signature (fifths). */
export function keyAlterations(fifths: number): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  if (fifths > 0) for (let i = 0; i < Math.min(7, fifths); i++) out[SHARP_LETTERS[i]] = 1;
  else if (fifths < 0) for (let i = 0; i < Math.min(7, -fifths); i++) out[FLAT_LETTERS[i]] = -1;
  return out;
}

export interface PitchedHead {
  head: Notehead;
  midi: number;
  spelling: Spelling;
  dia: number;
  alter: number;
}

export function diaToMidi(dia: number, alter: number): number {
  const letter = ((dia % 7) + 7) % 7;
  const octave = Math.floor(dia / 7);
  return (octave + 1) * 12 + BASE[letter] + alter;
}

/**
 * Resolve pitches for the heads of ONE measure (any order; they are processed left to right).
 * Applies key signature, explicit accidentals (persisting for the same line/space until the barline) and ties.
 * `carry` maps dia → alter from the previous measure (only used for tied notes); the returned map is the new carry.
 */
export function pitchMeasure(
  heads: Notehead[],
  staff: Staff,
  clef: ClefKind,
  fifths: number,
  carry: Map<number, number>,
): { pitched: PitchedHead[]; carry: Map<number, number> } {
  const keyAlt = keyAlterations(fifths);
  const memory = new Map<number, number>();
  const base = middleLineDia(clef);
  const pitched: PitchedHead[] = [];
  const sorted = [...heads].sort((a, b) => a.cx - b.cx);
  for (const h of sorted) {
    const step = headStep(staff, h.cx, h.cy);
    h.step = step;
    const dia = base + step;
    const letter = ((dia % 7) + 7) % 7;
    let alter: number;
    if (h.accidental) {
      alter = h.accidental === 'sharp' ? 1 : h.accidental === 'flat' ? -1 : 0;
      memory.set(dia, alter);
    } else if (memory.has(dia)) alter = memory.get(dia)!;
    else if (h.tiedFromPrevious && carry.has(dia)) {
      alter = carry.get(dia)!;
      memory.set(dia, alter);
    } else alter = keyAlt[letter];
    const midi = Math.max(0, Math.min(127, diaToMidi(dia, alter)));
    pitched.push({
      head: h,
      midi,
      dia,
      alter,
      spelling: { step: LETTERS[letter], alter, octave: Math.floor(dia / 7) },
    });
  }
  const next = new Map<number, number>();
  for (const p of pitched) next.set(p.dia, p.alter);
  return { pitched, carry: next };
}
