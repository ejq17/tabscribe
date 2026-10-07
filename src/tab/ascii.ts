import { measuresOf, guitarTrack, NOTE_NAMES_SHARP, NOTE_NAMES_FLAT } from '../core';
import type { Score, GuitarConfig, Note } from '../core';
import type { ChordEvent } from '../chords';
import { assignTab } from './engine';

function pickUnit(ppq: number, ticks: number[]): number {
  for (const div of [4, 8, 12, 6, 24, 16, 48]) {
    const u = ppq / div;
    if (Number.isInteger(u) && ticks.every((t) => Math.abs(t / u - Math.round(t / u)) < 1e-6)) return u;
  }
  return ppq / 8;
}

function stringLabels(g: GuitarConfig): string[] {
  const flats = g.tuning.pitches.some((p) => [3, 8, 10].includes(((p % 12) + 12) % 12));
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const raw = g.tuning.pitches.map((p) => names[((p % 12) + 12) % 12]);
  const w = Math.max(...raw.map((r) => r.length));
  return raw.map((r, i) => (i === 0 && r.length === 1 ? r.toLowerCase() : r).padEnd(w, ' '));
}

const ART_CHARS: [string, string][] = [['hammer', 'h'], ['pull', 'p'], ['slide', '/'], ['bend', 'b']];

export function toAsciiTab(score: Score, guitar: GuitarConfig, opts?: { measuresPerLine?: number; chords?: ChordEvent[] }): string {
  const perLine = Math.max(1, opts?.measuresPerLine ?? 4);
  const track0 = guitarTrack(score);
  let sc = score;
  if (track0 && track0.notes.some((n) => !n.tab && !n.tiedFromPrevious)) sc = assignTab(score, guitar);
  const track = guitarTrack(sc);
  const nStr = guitar.tuning.pitches.length;
  const labels = stringLabels(guitar);
  const tuningLow = [...guitar.tuning.pitches].reverse();
  const flats = guitar.tuning.pitches.some((p) => [3, 8, 10].includes(((p % 12) + 12) % 12));
  const nm = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const header = [
    sc.meta.title ?? 'Untitled',
    `Tuning: ${tuningLow.map((p) => nm[((p % 12) + 12) % 12]).join(' ')} (${guitar.tuning.name})   Capo: ${guitar.capo > 0 ? guitar.capo : 'none'}`,
    '',
  ];
  if (!track) return header.join('\n');
  const notes = track.notes.filter((n) => n.tab && !n.tiedFromPrevious);
  const measures = measuresOf(sc);
  const unit = pickUnit(sc.ppq, [...notes.map((n) => n.start), ...measures.map((m) => m.startTick), ...(opts?.chords ?? []).map((c) => c.tick)]);

  // per measure grid
  interface Cell { fret: number | null; sep: string }
  const mGrids: Cell[][][] = []; // [measure][string][col]
  const mCols: number[] = [];
  for (const m of measures) {
    const cols = Math.max(1, Math.ceil((m.endTick - m.startTick) / unit - 1e-6));
    mCols.push(cols);
    mGrids.push(Array.from({ length: nStr }, () => Array.from({ length: cols }, () => ({ fret: null, sep: '-' }))));
  }
  const mIndex = (tick: number): number => {
    for (const m of measures) if (tick >= m.startTick && tick < m.endTick) return m.index;
    return -1;
  };
  const colOf = (mi: number, tick: number): number => Math.min(mCols[mi] - 1, Math.max(0, Math.round((tick - measures[mi].startTick) / unit)));
  const placed = new Map<number, { mi: number; col: number; note: Note }[]>(); // per string
  for (const n of notes) {
    const mi = mIndex(n.start);
    if (mi < 0 || !n.tab || n.tab.string >= nStr) continue;
    const col = colOf(mi, n.start);
    mGrids[mi][n.tab.string][col].fret = n.tab.fret - guitar.capo;
    const arr = placed.get(n.tab.string) ?? [];
    arr.push({ mi, col, note: n });
    placed.set(n.tab.string, arr);
  }
  // articulations between adjacent notes on the same string
  for (const arr of placed.values()) {
    arr.sort((a, b) => a.note.start - b.note.start);
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i], b = arr[i + 1];
      if (b.note.start === a.note.start) continue;
      const arts = [...(a.note.articulations ?? []), ...(b.note.articulations ?? [])];
      const hit = ART_CHARS.find(([k]) => arts.includes(k));
      if (!hit || a.mi !== b.mi || b.col <= a.col) continue;
      const str = a.note.tab!.string;
      mGrids[b.mi][str][b.col - 1].sep = hit[1];
    }
  }
  const out: string[] = [...header];
  const chordsSorted = [...(opts?.chords ?? [])].sort((a, b) => a.tick - b.tick);
  const labelW = labels[0].length + 1;
  for (let start = 0; start < measures.length; start += perLine) {
    const group = measures.slice(start, start + perLine);
    // column widths
    const widths: number[][] = group.map((m) => {
      const w: number[] = [];
      for (let c = 0; c < mCols[m.index]; c++) {
        let mx = 1;
        for (let s = 0; s < nStr; s++) { const f = mGrids[m.index][s][c].fret; if (f !== null) mx = Math.max(mx, String(f).length); }
        w.push(mx);
      }
      return w;
    });
    const lines: string[] = labels.map((l) => l + '|');
    const chordChars: string[] = Array.from({ length: labelW }, () => ' ');
    group.forEach((m, gi) => {
      const base = lines[0].length;
      const offsets: number[] = [];
      let off = 0;
      for (let c = 0; c < mCols[m.index]; c++) { offsets.push(off); off += widths[gi][c] + 1; }
      for (let s = 0; s < nStr; s++) {
        let str = '';
        for (let c = 0; c < mCols[m.index]; c++) {
          const cell = mGrids[m.index][s][c];
          const txt = cell.fret === null ? '' : String(cell.fret);
          str += txt.padStart(widths[gi][c], '-') + cell.sep;
        }
        lines[s] += str + '|';
      }
      // chords in this measure
      for (const ch of chordsSorted) {
        if (ch.tick < m.startTick || ch.tick >= m.endTick) continue;
        const pos = base + offsets[colOf(m.index, ch.tick)];
        // pad chord line up to this position
        while (chordChars.length < pos) chordChars.push(' ');
        if (chordChars.length > pos) continue; // collides with previous name
        for (const chr of ch.name) chordChars.push(chr);
        chordChars.push(' ');
      }
      // keep the chord line in step with the tab line (account for barline)
      const target = lines[0].length;
      while (chordChars.length < target) chordChars.push(' ');
    });
    const chordLine = chordChars.join('').replace(/\s+$/, '');
    if (opts?.chords && chordLine.trim()) out.push(chordLine);
    else if (opts?.chords) out.push('');
    out.push(...lines);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}
