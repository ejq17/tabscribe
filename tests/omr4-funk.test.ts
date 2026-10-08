import { describe, it, expect } from 'vitest';
import { analyzePage } from '../src/omr/assemble';
import { recognizeImageData } from '../src/omr';
import { pulseTicks } from '../src/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Canvas, TOP, yStep, staff, filledHead, trebleClef } from './fixtures/omr/synth';

const BITS: Record<string, string[]> = {
  '3': ['####.', '....#', '....#', '.###.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
};
function glyph(c: Canvas, ch: string, x: number, y: number, s: number) {
  BITS[ch].forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') c.rect(x + rx * s, y + ry * s, x + rx * s + s - 1, y + ry * s + s - 1);
  });
}
function flat(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 24, x + 1, cy + 6);
  c.ellipse(x + 5, cy + 1, 4.5, 4.5);
  c.ellipse(x + 5, cy + 1, 1.6, 1.8, false);
  c.rect(x, cy - 6, x + 1, cy + 6);
}
/** the key signature of n flats (Bb Eb Ab Db) from x0, 11 px apart */
function flats(c: Canvas, x0: number, n: number) {
  [0, 2, -1, 1].slice(0, n).forEach((step, i) => flat(c, x0 + i * 11, yStep(step)));
}
const analyze = (c: Canvas, i = 0) => analyzePage(c.img(), 0).symbols[i];
const notesOf = (c: Canvas) => recognizeImageData([c.img()]).tracks.flatMap((t) => t.notes);
/** a common-time C (thick left arc) with an optional cut stroke through it */
function cSign(c: Canvas, x: number, cut: boolean) {
  const mid = yStep(0);
  c.ellipse(x, mid, 8, 11);
  c.ellipse(x + 3, mid, 5, 7.5, false);
  c.rect(x + 4, mid - 5, x + 12, mid + 5, false);
  if (cut) c.rect(x - 1, mid - 17, x, mid + 17);
}

describe('omr4 funk: C vs cut-C next to a flat key signature', () => {
  it('keeps a common-time C after a 4-flat key at 4/4 (and marks it as a printed sign)', () => {
    const c = new Canvas(460, 260);
    staff(c, 40, 440);
    trebleClef(c, 48);
    flats(c, 78, 4);
    cSign(c, 150, false);
    filledHead(c, 260, 0);
    c.rect(439, TOP, 440, TOP + 41);
    const s = analyze(c);
    expect(s.keyFifths).toBe(-4);
    expect(s.timeSig).toMatchObject({ numerator: 4, denominator: 4, fromSign: true });
  });

  it('reads the cut-C after a 4-flat key as 2/2 from a sign', () => {
    const c = new Canvas(460, 260);
    staff(c, 40, 440);
    trebleClef(c, 48);
    flats(c, 78, 4);
    cSign(c, 150, true);
    filledHead(c, 260, 0);
    c.rect(439, TOP, 440, TOP + 41);
    expect(analyze(c).timeSig).toMatchObject({ numerator: 2, denominator: 2, fromSign: true });
  });

  it('reads a 4 over 4 printed as digits on a real engraving as 4/4 and detects the clef on every staff', async () => {
    const img = await loadImage(readFileSync(join(__dirname, 'fixtures/omr/corpus/londonderry-air/page-1.png')));
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, cv.width, cv.height);
    const page = analyzePage({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray }, 0);
    expect(page.symbols[0].timeSig).toMatchObject({ numerator: 4, denominator: 4 });
    expect(page.symbols.every((s) => s.clefDetected)).toBe(true);
  });
});

describe('omr4 funk: clef on a later staff of the page', () => {
  it('detects the treble clef of the second staff', () => {
    const OFF = 220;
    const c = new Canvas(420, 520);
    staff(c, 40, 400);
    staff(c, 40, 400, TOP + OFF);
    trebleClef(c, 48);
    // the same clef, 220 px lower
    const x = 48;
    c.rect(x + 6, 80 + OFF, x + 8, 165 + OFF);
    c.ellipse(x + 7, 132 + OFF, 8, 12);
    c.ellipse(x + 7, 132 + OFF, 5, 9, false);
    c.rect(x + 6, 80 + OFF, x + 8, 165 + OFF);
    c.ellipse(x + 7, 160 + OFF, 4, 4);
    filledHead(c, 200, 0);
    c.rect(399, TOP, 400, TOP + 41);
    c.rect(399, TOP + OFF, 400, TOP + OFF + 41);
    const page = analyzePage(c.img(), 0);
    expect(page.symbols.length).toBe(2);
    expect(page.symbols[0].clefDetected).toBe(true);
    expect(page.symbols[1].clefDetected).toBe(true);
    expect(page.symbols[1].clef).toBe('treble');
  });
});

describe('omr4 funk: signature glyphs are never notes', () => {
  it('an undetectable (garbled) clef, a 2-flat key and a 3/4 produce no notes from those glyphs', () => {
    const c = new Canvas(460, 260);
    staff(c, 40, 440);
    // a scribble that is neither a treble nor a bass clef: two short blobs
    c.ellipse(55, TOP + 12, 5, 5);
    c.ellipse(60, TOP + 30, 4, 4);
    flats(c, 90, 2);
    glyph(c, '3', 130, TOP - 1, 3);
    glyph(c, '4', 130, TOP + 22, 3);
    filledHead(c, 260, 0);
    c.rect(439, TOP, 440, TOP + 41);
    const notes = notesOf(c);
    expect(notes.length).toBe(1);
    const s = analyze(c);
    expect(s.heads.length).toBe(1);
    expect(s.rests.length).toBe(0);
  });

  it('flags a time-signature glyph pair it cannot read instead of turning it into notes', () => {
    const c = new Canvas(460, 260);
    staff(c, 40, 440);
    flats(c, 90, 2);
    // two unrecognisable stacked blobs where a time signature belongs
    c.ellipse(140, TOP + 10, 5, 8);
    c.ellipse(140, TOP + 30, 5, 8);
    filledHead(c, 260, 0);
    c.rect(439, TOP, 440, TOP + 41);
    const s = analyze(c);
    expect(s.heads.length).toBe(1);
    expect(s.timeSigUnreadable).toBe(true);
    const warnings = (recognizeImageData([c.img()]).meta.warnings ?? []) as string[];
    expect(warnings.some((w) => /time signature could not be read/.test(w))).toBe(true);
  });
});

describe('omr4 funk: non-music grids and core helpers', () => {
  it('does not take a chord-diagram fret grid (five rules crossed by strings) for a staff', () => {
    const c = new Canvas(600, 300);
    for (let i = 0; i < 5; i++) c.rect(40, 100 + 26 * i, 560, 101 + 26 * i);
    for (let x = 40; x <= 560; x += 26) c.rect(x, 100, x + 1, 100 + 26 * 4 + 1);
    expect(analyzePage(c.img(), 0).staves.length).toBe(0);
  });

  it('counts the quarter pulse (never a half-note beat) in 2/2', () => {
    expect(pulseTicks(480, 2)).toBe(480);
    expect(pulseTicks(480, 4)).toBe(480);
    expect(pulseTicks(480, 8)).toBe(240);
  });
});
