/** Pure builder for strummed chord-accompaniment events (no Web Audio). */
import { guitarTrack, measuresOf, ticksToSeconds, timeSignatureAt, STANDARD_TUNING } from '../core';
import type { Measure, Score, Tuning } from '../core';
import { chordDiagram, simplifyChordName } from '../chords/shapes';
import type { ChordEvent } from '../chords/detect';

export interface ChordPlayEvent {
  t: number;
  dur: number;
  pitch: number;
  gain: number;
  chord: true;
}

export const STRING_GAP_SEC = 0.015;
/** per-string scale so six simultaneous voices do not swamp the melody */
const VOICE_SCALE = 0.85;
const LIGHT_FACTOR = 0.7;

/** MIDI pitches of a chord voicing, low string first. Null when the chord has no shape. */
export function chordVoicing(name: string, tuning: Tuning): number[] | null {
  let d = chordDiagram(name, tuning);
  if (!d) {
    const simple = simplifyChordName(name);
    if (simple && simple !== name) d = chordDiagram(simple, tuning);
  }
  if (!d) return null;
  const out: number[] = [];
  for (let i = d.frets.length - 1; i >= 0; i--) {
    const f = d.frets[i];
    if (f < 0 || i >= tuning.pitches.length) continue;
    out.push(tuning.pitches[i] + f);
  }
  return out.length ? out : null;
}

/**
 * Strum plan. Measures with melody notes get a light pattern (beat 1 and chord changes, lower gain);
 * empty / slash measures strum every beat (beat 1 accented).
 */
export function buildChordEvents(
  score: Score,
  chords: ChordEvent[],
  opts: { chordGain?: number; tuning?: Tuning } = {},
): { events: ChordPlayEvent[]; endTick: number } {
  const chordGain = opts.chordGain ?? 0.45;
  const tuning = opts.tuning ?? STANDARD_TUNING;
  const sorted = [...chords].sort((a, b) => a.tick - b.tick);
  if (sorted.length === 0) return { events: [], endTick: 0 };
  const track = guitarTrack(score);
  const noteStarts = (track ? track.notes : score.tracks.flatMap((t) => t.notes)).map((n) => n.start).sort((a, b) => a - b);
  const slash = new Set((score.meta.omrSlashMeasures ?? []).map((m) => m.tick));
  const eps = 1;
  const activeAt = (t: number): ChordEvent | null => {
    let best: ChordEvent | null = null;
    for (const c of sorted) {
      if (c.tick > t + eps) break;
      if (c.tick + c.duration > t + eps) best = c;
    }
    return best;
  };
  // chords can outlast the notes (trailing slash bars): extend the bar grid to the last chord end
  const measures: Measure[] = measuresOf(score);
  const lastChordEnd = Math.max(...sorted.map((c) => c.tick + c.duration));
  for (let guard = 0; guard < 10000; guard++) {
    const last = measures[measures.length - 1];
    const from = last ? last.endTick : 0;
    if (from >= lastChordEnd - 1e-6) break;
    const ts = timeSignatureAt(score, from);
    measures.push({ index: measures.length, startTick: from, endTick: from + (score.ppq * 4 * ts.numerator) / ts.denominator, timeSignature: ts });
  }
  const voicings = new Map<string, number[] | null>();
  const voicingOf = (name: string): number[] | null => {
    if (!voicings.has(name)) voicings.set(name, chordVoicing(name, tuning));
    return voicings.get(name) ?? null;
  };

  interface Strum { tick: number; chord: ChordEvent; gain: number }
  const strums: Strum[] = [];
  let noteIdx = 0;
  for (const m of measures) {
    while (noteIdx < noteStarts.length && noteStarts[noteIdx] < m.startTick) noteIdx++;
    const hasNotes = noteIdx < noteStarts.length && noteStarts[noteIdx] < m.endTick;
    const light = hasNotes && !slash.has(m.startTick);
    const beat = (score.ppq * 4) / m.timeSignature.denominator;
    let prev: ChordEvent | null = null;
    for (let t = m.startTick; t < m.endTick - 1e-6; t += beat) {
      const c = activeAt(t);
      if (c) {
        const first = t === m.startTick;
        const changed = c !== prev;
        if (!light || first || changed) {
          const accent = first ? 1 : 0.85;
          strums.push({ tick: t, chord: c, gain: chordGain * accent * (light ? LIGHT_FACTOR : 1) });
        }
      }
      prev = c;
    }
  }

  const events: ChordPlayEvent[] = [];
  let endTick = 0;
  const scoreEnd = measures.length ? measures[measures.length - 1].endTick : 0;
  for (let i = 0; i < strums.length; i++) {
    const s = strums[i];
    const pitches = voicingOf(s.chord.name);
    if (!pitches) continue;
    const next = strums[i + 1];
    const stopTick = Math.min(next ? next.tick : Infinity, s.chord.tick + s.chord.duration, scoreEnd || Infinity);
    if (stopTick <= s.tick) continue;
    endTick = Math.max(endTick, stopTick);
    const t0 = ticksToSeconds(score, s.tick);
    const dur = ticksToSeconds(score, stopTick) - t0;
    const n = pitches.length;
    pitches.forEach((pitch, k) => {
      const off = k * STRING_GAP_SEC;
      const ramp = n > 1 ? 0.8 + (0.2 * k) / (n - 1) : 1;
      events.push({ t: t0 + off, dur: Math.max(0.05, dur - off), pitch, gain: s.gain * ramp * VOICE_SCALE, chord: true });
    });
  }
  return { events, endTick };
}
