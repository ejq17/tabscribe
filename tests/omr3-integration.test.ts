import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createEmptyScore } from '../src/core/score';
import type { Note, Score } from '../src/core/score';
import { chordDiagram, mergeOmrChords, omrChordEvents, strumChart, type ChordEvent } from '../src/chords';
import { simplifyChordName } from '../src/chords/shapes';
import { STANDARD_TUNING } from '../src/core';
import { analyzePage, assembleScore, readPageChords, recognizeImageDataWithChords } from '../src/omr/assemble';
import type { ChordLabel } from '../src/omr/chordtext';

const PPQ = 480;
function scoreWith(meta: Record<string, unknown>, measures = 4): Score {
  const s = createEmptyScore();
  const notes: Note[] = [];
  for (let m = 0; m < measures; m++) notes.push({ id: 'n' + m, pitch: 60, start: m * 4 * PPQ, duration: PPQ, velocity: 90, voice: 0 });
  s.tracks = [{ id: 't', name: 't', program: 0, notes }];
  Object.assign(s.meta, meta);
  return s;
}
const entry = (measure: number, beat: number, text: string, root: string, quality: string, bass?: string) => ({
  measure, tick: (measure * 4 + beat) * PPQ, text, chord: { root, quality, bass }, confidence: 0.9,
});

describe('omr chords in the app', () => {
  it('converts meta.omrChords to events that hold until the next chord', () => {
    const s = scoreWith({ omrChords: [entry(0, 0, 'Bbmaj7', 'Bb', 'maj7'), entry(1, 0, 'Ebm6/F', 'Eb', 'm6', 'F'), entry(1, 2, 'Gm7', 'G', 'm7')] });
    const ev = omrChordEvents(s);
    expect(ev.map((e) => e.name)).toEqual(['Bbmaj7', 'Ebm6/F', 'Gm7']);
    expect(ev[0]).toMatchObject({ root: 10, source: 'omr', duration: 4 * PPQ });
    expect(ev[1]).toMatchObject({ root: 3, bass: 5, duration: 2 * PPQ });
    // the last printed chord stops at the end of the last measure that carries a printed symbol (measure 1), not at the score end
    expect(ev[2].tick + ev[2].duration).toBe(2 * 4 * PPQ);
  });

  it('caps the last printed chord at the end of its measure even when the score runs on', () => {
    const s = scoreWith({ omrChords: [entry(0, 0, 'Am', 'A', 'm')] }, 8);
    const [e] = omrChordEvents(s);
    expect(e.duration).toBe(4 * PPQ);
    const inferred: ChordEvent[] = [1, 2].map((m) => ({ tick: m * 4 * PPQ, duration: 4 * PPQ, name: 'C', root: 0, quality: '', pitches: [] }));
    expect(mergeOmrChords(s, inferred).map((c) => [c.name, c.duration])).toEqual([['Am', 4 * PPQ], ['C', 4 * PPQ], ['C', 4 * PPQ]]);
  });

  it('keeps the root of printed altered dominants (D7#9#5 must not become E)', () => {
    const s = scoreWith({ omrChords: [entry(0, 0, 'Bbmaj7', 'Bb', 'maj7'), entry(1, 0, 'D7#9#5', 'D', '7#9#5')] });
    const ev = omrChordEvents(s);
    expect(ev.map((e) => e.name)).toEqual(['Bbmaj7', 'D7#9#5']);
    expect(ev[1].root).toBe(2);
    // the displayed (UI) name goes through simplifyChordName / chordDiagram
    expect(simplifyChordName('D7#9#5')?.startsWith('D7')).toBe(true);
    expect(chordDiagram('D7#9#5', STANDARD_TUNING)?.name.startsWith('D7')).toBe(true);
    const chart = strumChart(s, ev);
    const names = chart.flatMap((l) => l.cells.map((c) => c.chord)).filter(Boolean);
    expect(names).toContain('D7#9#5');
    expect(names.some((n) => n!.startsWith('E'))).toBe(false);
  });

  it('printed chords replace inferred ones only in measures that have them', () => {
    const s = scoreWith({ omrChords: [entry(1, 0, 'Dm', 'D', 'm')] });
    const inferred: ChordEvent[] = [0, 1, 2].map((m) => ({ tick: m * 4 * PPQ, duration: 4 * PPQ, name: 'C', root: 0, quality: '', pitches: [] }));
    const merged = mergeOmrChords(s, inferred);
    expect(merged.map((c) => c.name)).toEqual(['C', 'Dm', 'C']);
    expect(mergeOmrChords(scoreWith({}), inferred)).toBe(inferred);
  });

  it('strum chart spreads a printed chord across slash beats', () => {
    const s = scoreWith({ omrChords: [entry(0, 0, 'Am', 'A', 'm')], omrSlashMeasures: [{ index: 0, tick: 0, length: 4 * PPQ }] });
    const lines = strumChart(s, omrChordEvents(s));
    expect(lines[0].cells.slice(0, 4).map((c) => c.chord)).toEqual(['Am', 'Am', 'Am', 'Am']);
  });

  it('draws diagrams for printed symbols the shape tables do not know', () => {
    expect(simplifyChordName('D7b9b5')).toBe('D7');
    expect(simplifyChordName('Am11')).toBe('Am7');
    expect(simplifyChordName('Gmadd2')).toBe('Gm');
    expect(simplifyChordName('Cfoo')).toBeNull();
    const d = chordDiagram('D7b9b5', STANDARD_TUNING);
    expect(d?.name).toBe('D7b9b5');
    expect(chordDiagram('Gmadd2', STANDARD_TUNING)).not.toBeNull();
  });
});

describe('assembler chord placement', () => {
  it('maps labels to measures and beats using barlines', async () => {
    const dir = resolve(__dirname, 'fixtures/omr/corpus/greensleeves/page-1.png');
    const img = await loadImage(readFileSync(dir));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const page = analyzePage({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray }, 0);
    expect(page.binary).toBeDefined();
    const bars = page.symbols[0].barlines;
    const mk = (x: number, text: string): ChordLabel => ({ x, text, chord: { root: text[0], quality: text.slice(1) }, confidence: 0.9 });
    const x2 = bars[1] + (bars[2] - bars[1]) * (2 / 3) + 10;
    page.chordLabels = [[mk(bars[0] + 12, 'Bb'), mk(x2, 'F'), mk(bars[0] + 14, 'Cx')]];
    const score = assembleScore([page]);
    const chords = score.meta.omrChords!;
    const ts = score.timeSignatures[0];
    const bar = (PPQ * 4 * ts.numerator) / ts.denominator;
    const beat = (PPQ * 4) / ts.denominator;
    // a label just right of the first barline is on beat 1 of measure index 1; the near-duplicate on the same beat is dropped
    expect(chords[0]).toMatchObject({ measure: 1, text: 'Bb', tick: bar });
    expect(chords.filter((x) => x.measure === 1)).toHaveLength(1);
    const f = chords.find((x) => x.text === 'F')!;
    expect(f.measure).toBe(2);
    expect(f.tick).toBeGreaterThan(2 * bar + beat); // well into the bar
    expect(f.tick).toBeLessThan(3 * bar);
    expect((f.tick - 2 * bar) % beat).toBe(0);
  });

  it('readPageChords never throws and recognizeImageDataWithChords works without OCR text', async () => {
    const blank = { width: 300, height: 300, data: new Uint8ClampedArray(300 * 300 * 4).fill(255) };
    const page = analyzePage(blank, 0);
    expect(await readPageChords(page)).toEqual([]);
    const score = await recognizeImageDataWithChords([blank]);
    expect(score.meta.omrChords).toBeUndefined();
  });
});
