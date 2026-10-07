import { measuresOf } from '../core';
import type { Score } from '../core';
import type { ChordEvent } from './detect';

export interface StrumLine {
  /** 0-based index of first measure on the line */
  measureStart: number;
  /** 0-based index of last measure on the line (inclusive) */
  measureEnd: number;
  cells: { tick: number; chord: string | null }[];
  startTick?: number;
  endTick?: number;
}

export function strumChart(score: Score, chords: ChordEvent[]): StrumLine[] {
  const ms = measuresOf(score);
  const lines: StrumLine[] = [];
  const sorted = [...chords].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < ms.length; i += 4) {
    const group = ms.slice(i, i + 4);
    const cells: StrumLine['cells'] = [];
    for (const m of group) {
      const beat = (score.ppq * 4) / m.timeSignature.denominator;
      for (let t = m.startTick; t < m.endTick - 1e-6; t += beat) {
        // chords read from the printed score hold until the next chord; inferred ones only mark their own beat
        const ev =
          sorted.find((c) => c.tick >= t && c.tick < t + beat) ??
          [...sorted].reverse().find((c) => c.source === 'omr' && c.tick < t && c.tick + c.duration > t);
        cells.push({ tick: t, chord: ev ? ev.name : null });
      }
    }
    lines.push({ measureStart: group[0].index, measureEnd: group[group.length - 1].index, cells, startTick: group[0].startTick, endTick: group[group.length - 1].endTick });
  }
  return lines;
}
