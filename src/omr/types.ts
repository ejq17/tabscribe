/** Shared plain-data types for the OMR pipeline (no DOM dependencies; structured-clone safe). */

/** RGBA pixel buffer, same shape as the DOM ImageData. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Binary image: 1 = ink, 0 = paper. */
export interface Binary {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ClefKind = 'treble' | 'bass';

export interface StaffBand {
  /** Column-band center x */
  x: number;
  /** y of each of the five lines at this x (top → bottom) */
  ys: number[];
}

export interface Staff {
  /** Mean y of the 5 lines, top → bottom */
  lines: number[];
  /** Per-column-band line positions (handles slight curvature) */
  bands: StaffBand[];
  left: number;
  right: number;
  /** Distance between adjacent line centers, in pixels */
  staffSpace: number;
  lineThickness: number;
  top: number;
  bottom: number;
  /** Index into the `systems` array */
  system: number;
  /** Position of the staff inside its system (0 = top) */
  partIndex: number;
  /** True when this staff is the lower staff of a piano grand staff */
  lowerOfGrand: boolean;
}

export interface OmrBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page-level geometry transform from the processed (scaled/deskewed) image back to the original page pixels. */
export interface PageTransform {
  scale: number;
  /** Rotation (radians) that was applied to the binary image about (cx, cy) in processed coordinates */
  angle: number;
  cx: number;
  cy: number;
  originalWidth: number;
  originalHeight: number;
}

export type AccidentalKind = 'sharp' | 'flat' | 'natural';

export interface Notehead {
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  hollow: boolean;
  stemId: number; // -1 = no stem
  dots: number;
  accidental?: AccidentalKind;
  tiedFromPrevious: boolean;
  /** 0..1 classification confidence */
  confidence: number;
  /** diatonic step relative to the staff middle line (filled in by pitch.ts) */
  step: number;
}

export interface StemInfo {
  id: number;
  x: number;
  top: number;
  bottom: number;
  up: boolean;
  /** number of beams / flags on this stem */
  flags: number;
  beamed: boolean;
}

export type RestKind = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

export interface RestSym {
  kind: RestKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dots: number;
}

export interface StaffSymbols {
  clef: ClefKind;
  clefDetected: boolean;
  keyFifths: number;
  timeSig?: { numerator: number; denominator: number; fromSign?: boolean };
  musicStart: number;
  heads: Notehead[];
  stems: StemInfo[];
  rests: RestSym[];
  /** x positions of barlines (after the music start) */
  barlines: number[];
  warnings: string[];
  /** right edge of the staff (page x) */
  staffRight?: number;
  /** no clef glyph was found on this staff (the default / inherited clef is used) */
  clefMissing?: boolean;
  /** a time-signature digit stack was found but could not be read */
  timeSigUnreadable?: boolean;
  /** chord slash marks (diagonal strokes on the middle line); they never become notes */
  slashes?: { cx: number; cy: number }[];
  /** multi-measure rest bars with the number of measures they stand for */
  multiRests?: { x0: number; x1: number; count: number; guessed: boolean }[];
  /** triplet brackets / digits: x extent of the notation they span (page coordinates) */
  tuplets?: { x0: number; x1: number; n: number }[];
  /** tuplet brackets seen near this staff (page coordinates); analyzePage hands each to the staff whose notes it spans */
  tupletCands?: { x0: number; x1: number; n: number; y0: number; y1: number }[];
  /** the staff ends with a tie arc that has no right-hand notehead (tie across the line break) */
  tieOut?: Notehead;
  /** all heads whose tie arc runs off the end of the staff (chords can have several) */
  tieOuts?: Notehead[];
  /**
   * Key / time signatures printed inside or at the END of the staff (courtesy signatures after a double barline).
   * `barline` is the index into `barlines` of the barline the signature follows; the signature applies from the next
   * measure (for the last barline: from the first measure of the next system). `x0..x1` is the glyph extent, so
   * rhythm.ts can discard any rest / dot fragments the glyphs left behind. Filled by the symbol layer (optional).
   */
  signatureChanges?: { barline: number; x0: number; x1: number; timeSig?: { numerator: number; denominator: number; fromSign?: boolean }; keyFifths?: number; unreadable?: boolean }[];
}

export interface PageResult {
  index: number;
  width: number;
  height: number;
  transform: PageTransform;
  staves: Staff[];
  /** systems → staff indices */
  systems: number[][];
  symbols: StaffSymbols[];
  warnings: string[];
  /** processed (binary) page image; kept so chord-symbol OCR can run after analysis. Delete before posting to the UI. */
  binary?: Binary;
  /** noisy scans: smoothed grey page (same coordinates as `binary`) for chord-text OCR. Deleted with `binary`. */
  grey?: Uint8Array;
  /** chord-symbol labels read above the FIRST staff of each system (index = system index); set by `readPageChords` */
  chordLabels?: import('./chordtext').ChordLabel[][];
  /**
   * Per staff (same index as `staves`): -1 when a small "8" was found below a treble clef (tenor / guitar clef: the
   * music sounds an octave lower than written), 0 otherwise. Set by `analyzePage`; absent = all 0.
   */
  clefOctaves?: number[];
}

/**
 * Which instrument the written music is for. 'concert' (default): pitches are read as written, except under a treble
 * clef with a printed "8" below it (sounds an octave lower). 'guitar': treble clefs are read an octave lower (guitar
 * music is notated an octave above its sounding pitch, usually without a printed "8"), except in a piano grand staff or any
 * system containing a bass-clef staff.
 */
export type OmrInstrument = 'guitar' | 'concert';

export interface RecognizeOptions {
  defaultClef?: ClefKind;
  instrument?: OmrInstrument;
  onProgress?: (p: { stage: string; fraction: number; page?: number }) => void;
}
