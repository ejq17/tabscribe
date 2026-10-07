import type { GuitarConfig, Note, Score, TabPosition, Track } from '../core';
import { guitarTrack } from '../core';

/** Fret on `string` (relative to the nut) that sounds `pitch`, or null if unplayable. */
export function fretOn(pitch: number, string: number, guitar: GuitarConfig): number | null {
  const open = guitar.tuning.pitches[string];
  if (open === undefined) return null;
  const fret = pitch - open;
  if (fret < guitar.capo || fret > guitar.maxFret) return null;
  return fret;
}

/** All strings that can play `pitch`, ordered high to low. */
export function playableStrings(pitch: number, guitar: GuitarConfig): number[] {
  const out: number[] = [];
  for (let s = 0; s < guitar.tuning.pitches.length; s++) if (fretOn(pitch, s, guitar) !== null) out.push(s);
  return out;
}

export type NotePatch = Partial<Pick<Note, 'pitch' | 'duration' | 'start' | 'tab' | 'tabLocked' | 'articulations' | 'spelling' | 'voice' | 'tiedFromPrevious'>>;

/** Pure: apply a user patch to a note following the tab-locking rules. */
export function applyPatch(note: Note, patch: NotePatch, guitar: GuitarConfig): Note {
  const n: Note = { ...note, ...patch };
  if (patch.tab) {
    if (patch.tabLocked === undefined) n.tabLocked = true;
    if (patch.pitch === undefined) {
      const open = guitar.tuning.pitches[patch.tab.string];
      if (open !== undefined) n.pitch = open + patch.tab.fret;
    }
  }
  if (n.pitch !== note.pitch) {
    if (patch.spelling === undefined) delete n.spelling;
    if (!patch.tab) {
      const keep: TabPosition | undefined =
        note.tabLocked && note.tab && fretOn(n.pitch, note.tab.string, guitar) !== null
          ? { string: note.tab.string, fret: fretOn(n.pitch, note.tab.string, guitar)! }
          : undefined;
      if (keep) n.tab = keep;
      else {
        delete n.tab;
        n.tabLocked = false;
      }
    }
  }
  return n;
}

export function targetTrack(score: Score): Track | undefined {
  return guitarTrack(score);
}

/** Pure: map over the notes of the guitar track. */
export function mapGuitarNotes(score: Score, fn: (n: Note) => Note): Score {
  const t = guitarTrack(score);
  if (!t) return score;
  return { ...score, tracks: score.tracks.map((x) => (x === t ? { ...x, notes: x.notes.map(fn) } : x)) };
}

export function guitarNotes(score: Score | null): Note[] {
  return score ? (guitarTrack(score)?.notes ?? []) : [];
}

/** Notes sorted by start then pitch descending (reading order). */
export function sortedNotes(score: Score | null): Note[] {
  return [...guitarNotes(score)].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
}
