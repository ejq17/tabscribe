import { measuresOf, pitchClass } from '../core';
import type { Score } from '../core';
import type { ChordEvent } from './detect';

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pcOf(name: string): number | null {
  const base = ROOTS[name[0]];
  if (base === undefined) return null;
  return pitchClass(base + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0));
}

/** Chord events for the chord symbols OMR read from the printed score (`meta.omrChords`); [] when there are none. */
export function omrChordEvents(score: Score): ChordEvent[] {
  const list = score.meta.omrChords;
  if (!list || list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.tick - b.tick);
  const measures = measuresOf(score);
  const scoreEnd = Math.max(...measures.map((m) => m.endTick), 0);
  // a printed chord does not run past the end of the last measure that carries a printed symbol (what follows is the
  // business of the inferred chords)
  const lastTick = sorted[sorted.length - 1].tick;
  const lastMeasure = measures.find((m) => lastTick >= m.startTick && lastTick < m.endTick);
  const end = lastMeasure ? lastMeasure.endTick : scoreEnd;
  const events: ChordEvent[] = [];
  sorted.forEach((c, i) => {
    const root = pcOf(c.chord.root);
    if (root === null) return;
    const bass = c.chord.bass ? pcOf(c.chord.bass) : null;
    const next = sorted.slice(i + 1).find((o) => o.tick > c.tick);
    events.push({
      tick: c.tick,
      // a printed chord holds until the next one (or the end of the last measure with a printed symbol)
      duration: Math.max(1, (next ? next.tick : Math.max(end, c.tick + 1)) - c.tick),
      name: c.text,
      root,
      quality: c.chord.quality,
      bass: bass ?? undefined,
      pitches: [],
      source: 'omr',
    });
  });
  return events;
}

/**
 * Combine chords inferred from the notes with chords read by OMR. In every measure that has a printed chord symbol the
 * printed ones win and inferred chords are dropped; measures without a printed symbol keep the inferred chords.
 */
export function mergeOmrChords(score: Score, inferred: ChordEvent[]): ChordEvent[] {
  const omr = omrChordEvents(score);
  if (omr.length === 0) return inferred;
  const covered = measuresOf(score).filter((m) => omr.some((c) => c.tick >= m.startTick && c.tick < m.endTick));
  const kept = inferred.filter((c) => !covered.some((m) => c.tick >= m.startTick && c.tick < m.endTick));
  return [...kept, ...omr].sort((a, b) => a.tick - b.tick);
}
