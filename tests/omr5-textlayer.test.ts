import { describe, expect, it } from 'vitest';
import { parseChordExact } from '../src/omr/chordtext';
import { analyzeTextLayer, mergeRuns, tempoFromText, type PdfTextItem } from '../src/omr/textlayer';
import { assembleScore, readPageChords } from '../src/omr/assemble';
import type { PageResult, Staff, StaffSymbols } from '../src/omr/types';

const transform = { scale: 1, angle: 0, cx: 500, cy: 300, originalWidth: 1000, originalHeight: 600 };
const staff = (top = 100): Staff => ({
  lines: [0, 1, 2, 3, 4].map((i) => top + 10 * i),
  bands: [],
  left: 50,
  right: 650,
  staffSpace: 10,
  lineThickness: 2,
  top,
  bottom: top + 40,
  system: 0,
  partIndex: 0,
  lowerOfGrand: false,
});
const geom = (staves: Staff[] = [staff()]) => ({ staves, systems: staves.map((_, i) => [i]), transform });
const item = (str: string, x: number, y: number, w = 8 * str.length, h = 12, font?: string): PdfTextItem => ({ str, x, y, w, h, font });

describe('parseChordExact', () => {
  it.each([
    ['A°', 'Adim'],
    ['C7(#9,#5)', 'C7#9#5'],
    ['E♭6/B♭', 'Eb6/Bb'],
    ['E♭7(#9)', 'Eb7#9'],
    ['B♭7', 'Bb7'],
    ['Gmaj7', 'Gmaj7'],
    ['F△7', 'Fmaj7'],
    ['Dø7', 'Dm7b5'],
    ['Cm7(♭5)', 'Cm7b5'],
    ['Bb Maj7', 'Bbmaj7'],
  ])('reads %s', (raw, text) => {
    expect(parseChordExact(raw)?.text).toBe(text);
  });
  it('never repairs words into chords', () => {
    for (const w of ['Coda', 'Dal', 'Fine', 'Guitar', 'FAST', 'Swing', 'A tempo', '•', '']) expect(parseChordExact(w)).toBeNull();
  });
});

describe('text layer -> chord labels', () => {
  it('merges root, accidental and superscript runs that touch, and keeps separate chords apart', () => {
    const runs = mergeRuns(
      [
        { str: 'B', x0: 200, x1: 208, y: 88, h: 12 },
        { str: '♭', x0: 208, x1: 214, y: 88, h: 12 },
        { str: '7', x0: 214, x1: 220, y: 82, h: 8 },
        { str: ' ', x0: 220, x1: 250, y: 88, h: 12 },
        { str: 'Fm7', x0: 250, x1: 280, y: 88, h: 12 },
      ],
      10,
    );
    expect(runs.map((r) => r.str)).toEqual(['B♭7', 'Fm7']);
  });

  it('builds labels with exact left edge, confidence 1, and skips bar numbers / rehearsal letters / prose', () => {
    const tl = analyzeTextLayer(
      [
        item('Fm7', 100, 88, 27, 12, 'f1'),
        item('B♭7', 160, 88, 27, 12, 'f1'),
        item('E', 300, 88, 8, 12, 'f1'), // a plain chord letter in the chord font stays a chord
        item('A', 60, 70, 10, 12, 'f5'), // rehearsal letter: another font
        item('Swing', 400, 70, 40, 12, 'f3'),
        item('1', 100, 165, 6, 9, 'f4'),
        item('Coda', 500, 88, 30, 12, 'f1'),
      ],
      geom(),
    );
    expect(tl.hasChords).toBe(true);
    const sys = tl.systems[0];
    expect(sys.chords.map((c) => c.text)).toEqual(['Fm7', 'Bb7', 'E']);
    expect(sys.chords.every((c) => c.confidence === 1)).toBe(true);
    expect(sys.chords[0].left).toBe(100);
    expect(sys.chords[0].x).toBeCloseTo(113.5, 1);
    expect(sys.reliable).toBe(true);
    expect(sys.numbers).toEqual([{ x: 100, xc: 103, n: 1, zone: 'below' }]);
  });

  it('decodes the Sibelius chord font ("G‹(„ˆˆ9)" is Gm(add9)) and SMuFL accidentals', () => {
    const tl = analyzeTextLayer([item('G‹(„ˆˆ9)', 100, 88, 100), item('Bmaj7', 300, 88, 60), item('E¨13', 400, 88, 40)], geom());
    expect(tl.systems[0].chords.map((c) => c.text)).toEqual(['Gmadd9', 'Bbmaj7', 'Eb13']);
    expect(tl.systems[0].reliable).toBe(true);
  });

  it('marks a band with undecodable private-use glyphs unreliable so OCR reads it instead', () => {
    const tl = analyzeTextLayer([item('Cm7', 100, 88), item('D 7', 300, 88)], geom());
    expect(tl.hasChords).toBe(true);
    expect(tl.systems[0].reliable).toBe(false);
  });

  it('counts the key signature from accidental glyphs at the staff start', () => {
    const tl = analyzeTextLayer([item('♭ ', 90, 115, 6, 24, 'f5'), item('♭ ', 100, 125, 6, 24, 'f5'), item('♭', 110, 112, 6, 24, 'f5'), item('Cm7', 300, 88)], geom());
    expect(tl.systems[0].keyFifths).toBe(-3);
    // an accidental inside the music is not part of the key
    const tl2 = analyzeTextLayer([item('♭', 400, 115, 6, 24, 'f5'), item('Cm7', 300, 88)], geom());
    expect(tl2.systems[0].keyFifths).toBeUndefined();
  });

  it('reads tempo marks: "♩ = 156" in the header, "q = 220" with a separate note-glyph run', () => {
    expect(tempoFromText('♩ = 156', 50)).toMatchObject({ bpm: 156, kind: 'numeric' });
    const tl = analyzeTextLayer([item('♩ = 156', 60, 40, 60, 12), item('Cm7', 300, 88)], geom());
    expect(tl.systems[0].tempos[0].bpm).toBe(156);
    const tl2 = analyzeTextLayer([item('q', 90, 60, 8, 12), item('= 220', 100, 60, 40, 12), item('Cm7', 300, 88)], geom());
    expect(tl2.systems[0].tempos[0].bpm).toBe(220);
  });

  it('a page with no chord-like text falls back to OCR (no text layer)', () => {
    const tl = analyzeTextLayer([item('Title', 100, 30, 80, 30), item('Page 1', 500, 580, 40)], geom());
    expect(tl.hasChords).toBe(false);
    expect(tl.hasNumbers).toBe(false);
  });
});

/** a one-staff page with five 100 px cells: 250 | 350 | 450 | 550 | 650; the third cell holds an H-bar read as 1 bar */
function page(): PageResult {
  const st = staff();
  const sym: StaffSymbols = {
    clef: 'treble',
    clefDetected: true,
    keyFifths: 0,
    musicStart: 150,
    heads: [],
    stems: [],
    rests: [],
    barlines: [250, 350, 450, 550, 650],
    warnings: [],
    staffRight: 650,
    multiRests: [{ x0: 365, x1: 435, count: 1, guessed: true }],
  };
  return { index: 0, width: 1000, height: 600, transform, staves: [st], systems: [[0]], symbols: [sym], warnings: [] };
}

describe('text layer through readPageChords / assembleScore', () => {
  const items = [
    item('Cm7', 160, 88, 27, 12, 'f1'),
    item('F7', 205, 88, 18, 12, 'f1'),
    item('G7', 455, 88, 18, 12, 'f1'),
    item('1', 160, 165, 6, 9),
    item('2', 260, 165, 6, 9),
    item('3', 360, 165, 6, 9),
    item('7', 460, 165, 6, 9),
    item('8', 560, 165, 6, 9),
    item('♭ ', 80, 115, 6, 24),
    item('♭ ', 90, 125, 6, 24),
    item('♩ = 120', 60, 40, 60),
  ];

  it('places chords by bar and beat without OCR (no binary needed) and uses printed bar numbers for the multi-rest length', async () => {
    const p = page();
    await readPageChords(p, { textItems: items });
    expect(p.textChords).toEqual([true]);
    const score = assembleScore([p]);
    // 1 + 1 + (7 - 3 = 4) + 1 + 1
    expect(score.meta.omrMeasures).toBe(8);
    const chords = score.meta.omrChords!;
    expect(chords.map((c) => [c.measure, c.tick, c.text])).toEqual([
      [0, 0, 'Cm7'],
      [0, 960, 'F7'],
      [6, 6 * 1920, 'G7'],
    ]);
    expect(score.keySignatures[0].fifths).toBe(-2);
    expect(score.tempos[0].bpm).toBe(120);
    expect(score.meta.omrSystems![0].textLayer).toBe(true);
  });

  it('keeps the image reading when no text layer is given (scans behave as before)', async () => {
    const p = page();
    await readPageChords(p, {});
    expect(p.textChords).toEqual([false]);
    expect(assembleScore([p]).meta.omrMeasures).toBe(5);
  });

  it('ignores printed numbers that are not increasing (a stray digit cannot corrupt the timeline)', async () => {
    const p = page();
    await readPageChords(p, { textItems: [...items.filter((i) => i.str !== '7' && i.str !== '8'), item('2', 460, 165, 6, 9), item('2', 560, 165, 6, 9)] });
    expect(assembleScore([p]).meta.omrMeasures).toBe(5);
  });
});
