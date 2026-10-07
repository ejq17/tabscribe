// STUB — replaced by the tab/chords agent. Keep these signatures.
import type { Score, Tuning, TabPosition } from '../core';
export interface ChordEvent { tick: number; duration: number; name: string; root: number; quality: string; bass?: number; pitches: number[] }
export interface ChordDiagram { name: string; frets: number[]; fingers?: number[]; baseFret: number; barres?: { fret: number; from: number; to: number }[] }
export interface StrumLine { measureStart: number; measureEnd: number; cells: { tick: number; chord: string | null }[] }
export function detectChords(_score: Score, _opts?: { resolution?: 'beat' | 'measure' | 'half' }): ChordEvent[] { return []; }
export function chordDiagram(_name: string, _tuning: Tuning): ChordDiagram | null { return null; }
export function diagramFromVoicing(_notes: TabPosition[], name: string): ChordDiagram { return { name, frets: [], baseFret: 1 }; }
export function strumChart(_score: Score, _chords: ChordEvent[]): StrumLine[] { return []; }
