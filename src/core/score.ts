/**
 * TabScribe core data model.
 *
 * EVERY importer (MIDI, MusicXML, ABC, Guitar Pro, OMR, audio) produces a `Score`.
 * EVERY consumer (tab engine, chord detector, renderer, editor, playback, exporters)
 * reads a `Score`. Do not add importer-specific fields here; put them in `meta`.
 *
 * Time is measured in TICKS. `Score.ppq` ticks per quarter note (default 480).
 * Pitch is a MIDI note number (60 = middle C / C4). Spelling (C# vs Db) is in `Note.spelling`.
 */

export const DEFAULT_PPQ = 480;

export type NoteId = string;

export interface Spelling {
  /** 0..6 for C D E F G A B */
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  /** -2..2 (double flat .. double sharp) */
  alter: number;
  octave: number;
}

export interface TabPosition {
  /** 0 = highest-pitched string (high e on standard tuning), 5 = low E. */
  string: number;
  /** 0 = open string. Fret number is relative to the nut, NOT the capo. */
  fret: number;
}

export interface Note {
  id: NoteId;
  /** MIDI note number 0..127 */
  pitch: number;
  /** Absolute start time in ticks from the beginning of the score */
  start: number;
  /** Duration in ticks */
  duration: number;
  /** 0..127, default 90 */
  velocity: number;
  /** Voice index within the track, 0 = primary */
  voice: number;
  /** Optional engraving spelling. If absent, derive from key signature. */
  spelling?: Spelling;
  /** Assigned by the tab engine; user edits override and set `tabLocked`. */
  tab?: TabPosition;
  /** When true, the tab engine must not reassign this note's string/fret. */
  tabLocked?: boolean;
  /** Tied from the previous note (same pitch); renderer draws a tie, playback merges. */
  tiedFromPrevious?: boolean;
  /** Articulations, free-form but use these when possible: 'staccato' | 'accent' | 'hammer' | 'pull' | 'slide' | 'bend' | 'harmonic' | 'palm-mute' */
  articulations?: string[];
  /** Importer confidence 0..1 (OMR / audio). Undefined means exact (MIDI, MusicXML). */
  confidence?: number;
}

export interface TimeSignature {
  /** Absolute tick where this applies */
  tick: number;
  numerator: number;
  /** 1,2,4,8,16 */
  denominator: number;
}

export interface KeySignature {
  tick: number;
  /** -7..7, negative = flats */
  fifths: number;
  mode: 'major' | 'minor';
}

export interface Tempo {
  tick: number;
  bpm: number;
}

export interface Tuning {
  name: string;
  /** MIDI pitches from string 0 (highest) to string N-1 (lowest). Standard: [64,59,55,50,45,40] */
  pitches: number[];
}

export const STANDARD_TUNING: Tuning = { name: 'Standard (EADGBE)', pitches: [64, 59, 55, 50, 45, 40] };

export const TUNINGS: Tuning[] = [
  STANDARD_TUNING,
  { name: 'Drop D', pitches: [64, 59, 55, 50, 45, 38] },
  { name: 'Half-step down (Eb)', pitches: [63, 58, 54, 49, 44, 39] },
  { name: 'Whole-step down (D)', pitches: [62, 57, 53, 48, 43, 38] },
  { name: 'DADGAD', pitches: [62, 57, 55, 50, 45, 38] },
  { name: 'Open G', pitches: [62, 59, 55, 50, 43, 38] },
  { name: 'Open D', pitches: [62, 57, 54, 50, 45, 38] },
  { name: 'Drop C', pitches: [62, 57, 53, 48, 43, 36] },
];

export interface GuitarConfig {
  tuning: Tuning;
  /** Capo fret, 0 = none. Tab frets are written relative to the capo in the renderer. */
  capo: number;
  /** Highest usable fret, default 22 */
  maxFret: number;
}

export const DEFAULT_GUITAR: GuitarConfig = { tuning: STANDARD_TUNING, capo: 0, maxFret: 22 };

export interface Track {
  id: string;
  name: string;
  /** General MIDI program 0..127, used for playback hints and MIDI export */
  program: number;
  notes: Note[];
  /** When true this track is the one being converted to tab. */
  isGuitarTarget?: boolean;
}

/** A chord symbol read from the printed score by OMR (see `meta.omrChords`). */
export interface OmrChord {
  /** 0-based measure index as counted by the OMR assembler */
  measure: number;
  /** absolute tick (nearest beat of its measure) */
  tick: number;
  text: string;
  chord: { root: string; quality: string; bass?: string };
  confidence: number;
}

export interface ScoreMeta {
  title?: string;
  composer?: string;
  /** Which importer created this score */
  source?: 'midi' | 'musicxml' | 'abc' | 'guitarpro' | 'omr' | 'audio' | 'manual';
  /** For OMR: rendered page images (data URLs) so the editor can show the original side by side */
  sourcePages?: string[];
  /** Importer-specific warnings to show the user */
  warnings?: string[];
  /** OMR: chord symbols read from the page; preferred over chords inferred from notes */
  omrChords?: OmrChord[];
  /** OMR: bars written in slash / chord-hit notation (no notes) */
  omrSlashMeasures?: { index: number; tick: number; length: number }[];
  [k: string]: unknown;
}

export interface Score {
  ppq: number;
  tracks: Track[];
  timeSignatures: TimeSignature[];
  keySignatures: KeySignature[];
  tempos: Tempo[];
  meta: ScoreMeta;
}

export function createEmptyScore(meta: ScoreMeta = {}): Score {
  return {
    ppq: DEFAULT_PPQ,
    tracks: [],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ tick: 0, fifths: 0, mode: 'major' }],
    tempos: [{ tick: 0, bpm: 120 }],
    meta,
  };
}

let idCounter = 0;
export function newNoteId(): NoteId {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Total length of the score in ticks. */
export function scoreLength(score: Score): number {
  let end = 0;
  for (const t of score.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.duration);
  return end;
}

/**
 * Ticks of one practice / strumming pulse in a time signature: the denominator unit, but never coarser than a quarter
 * note. Cut time (2/2) is felt in two, yet a guitarist counts, strums and clicks the quarter pulse; a half-note grid
 * halves the chord cells / metronome clicks and mis-places chords on beat 2 and 4.
 */
export function pulseTicks(ppq: number, denominator: number): number {
  return Math.min(ppq, (ppq * 4) / denominator);
}

/** Ticks per measure at a given tick. */
export function ticksPerMeasure(score: Score, tick: number): number {
  const ts = timeSignatureAt(score, tick);
  return (score.ppq * 4 * ts.numerator) / ts.denominator;
}

export function timeSignatureAt(score: Score, tick: number): TimeSignature {
  let cur = score.timeSignatures[0] ?? { tick: 0, numerator: 4, denominator: 4 };
  for (const ts of score.timeSignatures) if (ts.tick <= tick) cur = ts;
  return cur;
}

export function keySignatureAt(score: Score, tick: number): KeySignature {
  let cur = score.keySignatures[0] ?? { tick: 0, fifths: 0, mode: 'major' };
  for (const ks of score.keySignatures) if (ks.tick <= tick) cur = ks;
  return cur;
}

export function tempoAt(score: Score, tick: number): Tempo {
  let cur = score.tempos[0] ?? { tick: 0, bpm: 120 };
  for (const t of score.tempos) if (t.tick <= tick) cur = t;
  return cur;
}

export interface Measure {
  index: number;
  startTick: number;
  endTick: number;
  timeSignature: TimeSignature;
}

/** Split the score timeline into measures honoring time-signature changes. */
export function measuresOf(score: Score): Measure[] {
  const out: Measure[] = [];
  const total = Math.max(scoreLength(score), 1);
  let tick = 0;
  let index = 0;
  while (tick < total) {
    const ts = timeSignatureAt(score, tick);
    const len = (score.ppq * 4 * ts.numerator) / ts.denominator;
    out.push({ index, startTick: tick, endTick: tick + len, timeSignature: ts });
    tick += len;
    index += 1;
    if (index > 10000) break; // safety
  }
  return out;
}

/** Convert ticks to seconds honoring tempo changes. */
export function ticksToSeconds(score: Score, tick: number): number {
  const tempos = [...score.tempos].sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0) return (tick / score.ppq) * (60 / 120);
  let seconds = 0;
  for (let i = 0; i < tempos.length; i++) {
    const t = tempos[i];
    const next = tempos[i + 1];
    const segEnd = next && next.tick < tick ? next.tick : tick;
    if (segEnd > t.tick) seconds += ((segEnd - t.tick) / score.ppq) * (60 / t.bpm);
    if (!next || next.tick >= tick) break;
  }
  return seconds;
}

/** Deep clone a score (structured clone safe). */
export function cloneScore(score: Score): Score {
  return JSON.parse(JSON.stringify(score)) as Score;
}

/** The track that should be converted to tab: flagged one, else first with notes. */
export function guitarTrack(score: Score): Track | undefined {
  return score.tracks.find((t) => t.isGuitarTarget) ?? score.tracks.find((t) => t.notes.length > 0);
}
