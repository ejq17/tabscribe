import { describe, it, expect } from 'vitest';
import { createEmptyScore, newNoteId, DEFAULT_GUITAR, TUNINGS, nameToMidi } from '../src/core';
import type { Score, Note, GuitarConfig } from '../src/core';
import { assignTab, toAsciiTab } from '../src/tab';

const PPQ = 480;
function mk(pitches: (number | number[])[], dur = PPQ): Score {
  const s = createEmptyScore({ title: 'Test' });
  const notes: Note[] = [];
  pitches.forEach((p, i) => {
    for (const pitch of Array.isArray(p) ? p : [p]) notes.push({ id: newNoteId(), pitch, start: i * dur, duration: dur, velocity: 90, voice: 0 });
  });
  s.tracks.push({ id: 't', name: 'Guitar', program: 25, notes, isGuitarTarget: true });
  return s;
}
const notesOf = (s: Score) => s.tracks[0].notes;
const pitchFromTab = (n: Note, g: GuitarConfig) => g.tuning.pitches[n.tab!.string] + n.tab!.fret;

describe('assignTab', () => {
  it('does not mutate the input', () => {
    const s = mk([60]);
    const r = assignTab(s, DEFAULT_GUITAR);
    expect(s.tracks[0].notes[0].tab).toBeUndefined();
    expect(r.tracks[0].notes[0].tab).toBeDefined();
  });

  it('C major scale over two octaves gets sane, monotonic positions', () => {
    const scale = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
    const r = assignTab(mk(scale), DEFAULT_GUITAR);
    const ns = notesOf(r);
    let prevStr = 99;
    for (const n of ns) {
      expect(pitchFromTab(n, DEFAULT_GUITAR)).toBe(n.pitch);
      expect(n.tab!.fret).toBeLessThanOrEqual(12);
      expect(n.tab!.string).toBeLessThanOrEqual(prevStr);
      prevStr = n.tab!.string;
    }
    for (let i = 1; i < ns.length; i++) expect(Math.abs(ns[i].tab!.fret - ns[i - 1].tab!.fret)).toBeLessThanOrEqual(9);
  });

  it('C-E-G-C chord uses 4 distinct strings with span <= 4', () => {
    const r = assignTab(mk([[48, 52, 55, 60]]), DEFAULT_GUITAR);
    const ns = notesOf(r);
    expect(new Set(ns.map((n) => n.tab!.string)).size).toBe(4);
    const fr = ns.map((n) => n.tab!.fret).filter((f) => f > 0);
    expect(Math.max(...fr) - Math.min(...fr)).toBeLessThanOrEqual(4);
    for (const n of ns) expect(pitchFromTab(n, DEFAULT_GUITAR)).toBe(n.pitch);
  });

  it('keeps locked notes and avoids their strings', () => {
    const s = mk([[52, 64]]);
    const low = s.tracks[0].notes[0];
    low.tab = { string: 3, fret: 2 };
    low.tabLocked = true;
    const r = assignTab(s, DEFAULT_GUITAR);
    const [a, b] = notesOf(r);
    expect(a.tab).toEqual({ string: 3, fret: 2 });
    expect(b.tab!.string).not.toBe(3);
    expect(pitchFromTab(b, DEFAULT_GUITAR)).toBe(64);
  });

  it('transposes out-of-range notes and warns', () => {
    const s = mk([60, 60, 60, 60, nameToMidi('C7')!]);
    const r = assignTab(s, DEFAULT_GUITAR);
    const n = notesOf(r)[4];
    expect(n.pitch).toBeLessThan(nameToMidi('C7')!);
    expect(pitchFromTab(n, DEFAULT_GUITAR)).toBe(n.pitch);
    expect(r.meta.warnings!.some((w) => /Note C7 at measure 2 transposed down/.test(w))).toBe(true);
    // re-running does not duplicate warnings
    const r2 = assignTab(r, DEFAULT_GUITAR);
    expect(r2.meta.warnings!.filter((w) => w.includes('C7')).length).toBe(1);
  });

  it('drop D maps D2 to string 5 fret 0', () => {
    const dropD: GuitarConfig = { ...DEFAULT_GUITAR, tuning: TUNINGS.find((t) => t.name === 'Drop D')! };
    const r = assignTab(mk([38]), dropD);
    expect(notesOf(r)[0].tab).toEqual({ string: 5, fret: 0 });
  });

  it('capo 2 treats the capo as the nut', () => {
    const g: GuitarConfig = { ...DEFAULT_GUITAR, capo: 2 };
    // E2 (40) is below the capoed low string (42) -> transposed
    const r = assignTab(mk([40, 42, 47]), g);
    const ns = notesOf(r);
    for (const n of ns) {
      expect(n.tab!.fret).toBeGreaterThanOrEqual(2);
      expect(pitchFromTab(n, g)).toBe(n.pitch);
    }
    expect(ns[1].tab).toEqual({ string: 5, fret: 2 });
    expect(r.meta.warnings!.some((w) => w.includes('E2'))).toBe(true);
  });

  it('handles 6-note chords and drops extras with a warning', () => {
    const six = assignTab(mk([[40, 47, 52, 56, 59, 64]]), DEFAULT_GUITAR);
    expect(notesOf(six).every((n) => n.tab)).toBe(true);
    const seven = assignTab(mk([[40, 47, 52, 56, 59, 64, 67]]), DEFAULT_GUITAR);
    expect(notesOf(seven).filter((n) => n.tab).length).toBe(6);
    expect(seven.meta.warnings!.some((w) => /dropped/.test(w))).toBe(true);
  });

  it('tied notes inherit the source position', () => {
    const s = mk([64]);
    s.tracks[0].notes.push({ id: newNoteId(), pitch: 64, start: PPQ, duration: PPQ, velocity: 90, voice: 0, tiedFromPrevious: true });
    const r = assignTab(s, DEFAULT_GUITAR);
    expect(notesOf(r)[1].tab).toEqual(notesOf(r)[0].tab);
  });
});

describe('toAsciiTab', () => {
  it('renders 6 labelled lines with bars and fret numbers', () => {
    const s = mk([64, 59, 55, 50, 45, 40, 64, 59]);
    const r = assignTab(s, DEFAULT_GUITAR);
    const txt = toAsciiTab(r, DEFAULT_GUITAR, { measuresPerLine: 1 });
    expect(txt).toContain('Test');
    expect(txt).toContain('Tuning: E A D G B E');
    for (const l of ['e|', 'B|', 'G|', 'D|', 'A|', 'E|']) expect(txt).toContain(l);
    const eLine = txt.split('\n').find((l) => l.startsWith('e|'))!;
    expect(eLine.match(/\|/g)!.length).toBeGreaterThanOrEqual(2);
    expect(eLine).toMatch(/e\|0/);
    expect(txt.split('\n').filter((l) => l.startsWith('E|')).length).toBe(2);
  });

  it('shows fret numbers relative to the capo and chord names', () => {
    const g: GuitarConfig = { ...DEFAULT_GUITAR, capo: 2 };
    const s = mk([[47, 54]]);
    const r = assignTab(s, g);
    const txt = toAsciiTab(r, g, { chords: [{ tick: 0, duration: PPQ, name: 'Bm', root: 11, quality: 'm', pitches: [47, 54] }] });
    expect(txt).toContain('Capo: 2');
    expect(txt).toContain('Bm');
    const lines = txt.split('\n');
    const chordIdx = lines.findIndex((l) => l.trim() === 'Bm');
    expect(chordIdx).toBeGreaterThan(-1);
    // 47 is A string fret 2 -> relative 0
    const aLine = lines.find((l) => l.startsWith('A|'))!;
    expect(aLine.startsWith('A|0')).toBe(true);
    // chord name aligned with first column (after 'x|')
    expect(lines[chordIdx].indexOf('Bm')).toBe(2);
  });

  it('right-aligns two-digit frets and marks hammer-ons', () => {
    const s = mk([[64], [64]]);
    const [a, b] = notesOf(s);
    a.tab = { string: 0, fret: 5 }; a.tabLocked = true; a.articulations = ['hammer'];
    b.tab = { string: 0, fret: 12 }; b.tabLocked = true;
    b.start = PPQ / 4; a.duration = PPQ / 4;
    const txt = toAsciiTab(assignTab(s, DEFAULT_GUITAR), DEFAULT_GUITAR);
    const e = txt.split('\n').find((l) => l.startsWith('e|'))!;
    expect(e).toContain('5h12');
  });

  it('does not repeat tied notes', () => {
    const s = mk([64]);
    s.tracks[0].notes.push({ id: newNoteId(), pitch: 64, start: PPQ, duration: PPQ, velocity: 90, voice: 0, tiedFromPrevious: true });
    const txt = toAsciiTab(assignTab(s, DEFAULT_GUITAR), DEFAULT_GUITAR);
    const e = txt.split('\n').find((l) => l.startsWith('e|'))!;
    expect(e.match(/0/g)!.length).toBe(1);
  });
});
