import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { analyzePage } from '../src/omr/assemble';
import { recognizeImageData } from '../src/omr';
import { classifyDigit } from '../src/omr/symbols';
import { Canvas, TOP, yStep, staff, barline, filledHead, trebleClef } from './fixtures/omr/synth';

const analyze = (c: Canvas) => analyzePage(c.img(), 0).symbols[0];
const notesOf = (c: Canvas) => recognizeImageData([c.img()]).tracks.flatMap((t) => t.notes).sort((a, b) => a.start - b.start);

/** 5x7 bitmap digits; painted with a scale so that they are ~2 staff spaces tall (d = 10 px in the fixtures). */
const BITS: Record<string, string[]> = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
};
function glyph(c: Canvas, ch: string, x: number, y: number, s: number) {
  BITS[ch].forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') c.rect(x + rx * s, y + ry * s, x + rx * s + s - 1, y + ry * s + s - 1);
  });
}

/** A treble clef whose axis is slanted and curved: no column holds a straight run of 4 staff spaces. */
function curvedClef(c: Canvas, x: number) {
  c.line(x + 12, 78, x + 5, 105, 3);
  c.line(x + 5, 105, x + 13, 135, 3);
  c.line(x + 13, 135, x + 6, 165, 3);
  c.ellipse(x + 9, 132, 9, 12);
  c.ellipse(x + 9, 132, 5.5, 8.5, false);
  c.ellipse(x + 6, 166, 4, 4);
  c.line(x + 12, 78, x + 18, 92, 3);
}

describe('omr3 symbols: clef', () => {
  it('detects a treble clef whose axis is curved (no unbroken 4-space vertical run)', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    curvedClef(c, 48);
    filledHead(c, 200, 0);
    c.rect(379, TOP, 380, TOP + 41);
    expect(analyze(c).clefDetected).toBe(true);
    expect(analyze(c).clef).toBe('treble');
  });
});

describe('omr3 symbols: time signatures', () => {
  it('reads the bold stacked 3 over 4 of a real MuseScore page as 3/4 (digits merge at the middle line; the 3 has a flat top)', async () => {
    // tests/fixtures/omr/corpus/greensleeves is a 3/4 piece: after staff-line removal the digits are ONE ~4 space tall
    // component, and the flat-topped 3 used to be read as a 5 (5/4)
    const img = await loadImage(readFileSync(join(__dirname, 'fixtures/omr/corpus/greensleeves/page-1.png')));
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, cv.width, cv.height);
    const page = analyzePage({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray }, 0);
    expect(page.symbols[0].clefDetected).toBe(true);
    expect(page.symbols[0].timeSig).toEqual({ numerator: 3, denominator: 4 });
  });

  it('keeps a bold common-time C (thick left arc) at 4/4 and a cut C (stroke through it) at 2/2', () => {
    for (const cut of [false, true]) {
      const c = new Canvas(400, 260);
      staff(c, 40, 380);
      trebleClef(c, 48);
      const mid = yStep(0);
      c.ellipse(100, mid, 8, 11);
      c.ellipse(103, mid, 5, 7.5, false);
      c.rect(104, mid - 5, 112, mid + 5, false);
      if (cut) c.rect(99, mid - 17, 100, mid + 17);
      filledHead(c, 220, 0);
      c.rect(379, TOP, 380, TOP + 41);
      expect(analyze(c).timeSig).toMatchObject(cut ? { numerator: 2, denominator: 2 } : { numerator: 4, denominator: 4 });
    }
  });
});

/** Natural sign (thin verticals, right one lower) only ~1.5 spaces tall, as in compact engravings. */
function smallNatural(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 9, x + 1, cy + 6);
  c.rect(x + 7, cy - 4, x + 8, cy + 13);
  c.rect(x + 1, cy - 4, x + 6, cy - 3);
  c.rect(x + 1, cy + 4, x + 6, cy + 5);
}
function flat(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 24, x + 1, cy + 6);
  c.ellipse(x + 5, cy + 1, 4.5, 4.5);
  c.ellipse(x + 5, cy + 1, 1.6, 1.8, false);
  c.rect(x, cy - 6, x + 1, cy + 6);
}

describe('omr3 symbols: accidentals', () => {
  it('attaches a small natural sign (it must not be read as a flat) so it cancels a key-signature flat', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    trebleClef(c, 48);
    flat(c, 100, yStep(0)); // Bb
    filledHead(c, 200, 0); // Bb4 = 70
    barline(c, 240);
    smallNatural(c, 262, yStep(0));
    filledHead(c, 290, 0); // B4 = 71
    c.rect(399, TOP, 400, TOP + 41);
    // the sign applies to the head after it: B natural one semitone above the key-signature Bb (octave placement is the
    // assembler's business)
    const notes = notesOf(c);
    expect(notes.length).toBe(2);
    expect(notes[1].pitch - notes[0].pitch).toBe(1);
    expect(notes[1].spelling?.alter ?? 0).toBe(0);
  });
});

/** Quarter rest: a thick zigzag ~3 spaces tall. */
function quarterRest(c: Canvas, x: number) {
  const y0 = TOP + 6;
  c.line(x + 2, y0, x + 9, y0 + 9, 5);
  c.line(x + 9, y0 + 9, x + 3, y0 + 17, 6);
  c.line(x + 3, y0 + 17, x + 9, y0 + 24, 5);
  c.ellipse(x + 5, y0 + 25, 4, 3.5);
}
/** Eighth rest: round blob at the top, thin diagonal stem running down-left (~2 spaces tall). */
function eighthRest(c: Canvas, x: number) {
  const y0 = TOP + 10;
  c.ellipse(x + 3, y0 + 3, 3.5, 3.5);
  c.line(x + 6, y0 + 3, x + 2, y0 + 20, 2);
}

describe('omr3 symbols: rests', () => {
  it('tells a quarter rest (tall zigzag) from an eighth rest (blob + thin stem)', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    trebleClef(c, 48);
    quarterRest(c, 120);
    eighthRest(c, 200);
    filledHead(c, 290, 0);
    c.rect(399, TOP, 400, TOP + 41);
    const kinds = analyze(c).rests.map((r) => r.kind);
    expect(kinds).toEqual(['quarter', 'eighth']);
  });
});

describe('omr3 symbols: multi-measure rest counts', () => {
  const build = (digits: string) => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    trebleClef(c, 48);
    c.rect(130, TOP + 19, 400, TOP + 22);
    c.rect(130, yStep(0) - 7, 131, yStep(0) + 7);
    c.rect(399, yStep(0) - 7, 400, yStep(0) + 7);
    // number above the staff, 7 rows x 2 px, in two fragments for a 4 (diagonal / stem+bar) like a real bold digit
    const x0 = 265 - (digits.length * 12) / 2;
    [...digits].forEach((ch, i) => glyph(c, ch, x0 + i * 12, TOP - 34, 2));
    barline(c, 420);
    filledHead(c, 460, 0);
    c.rect(499, TOP, 500, TOP + 41);
    return c;
  };
  it('reads a "4" over the bar as 4 (not 3)', () => {
    expect(analyze(build('4')).multiRests?.[0]).toMatchObject({ count: 4, guessed: false });
  });
  it('reads a two-digit "12"', () => {
    expect(analyze(build('12')).multiRests?.[0]).toMatchObject({ count: 12, guessed: false });
  });
});

/** Thin ring tilted by ~35 degrees (as in engraved fonts), drawn pixel by pixel; the staff line stays inked through the hole. */
function tiltedRing(c: Canvas, cx: number, cy: number) {
  const ang = (-35 * Math.PI) / 180;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (let y = cy - 12; y <= cy + 12; y++)
    for (let x = cx - 14; x <= cx + 14; x++) {
      const u = (x - cx) * ca + (y - cy) * sa;
      const v = -(x - cx) * sa + (y - cy) * ca;
      const outer = (u * u) / (7.5 * 7.5) + (v * v) / (4.6 * 4.6);
      const inner = (u * u) / (5.0 * 5.0) + (v * v) / (2.6 * 2.6);
      if (outer <= 1 && inner > 1) c.set(x, y);
    }
}

describe('omr3 symbols: hollow heads', () => {
  it('finds a tilted half note sitting on the top line with its stem attached to the ring', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    trebleClef(c, 48);
    const cy = yStep(4); // F5, on the top line
    tiltedRing(c, 200, cy);
    c.rect(193, cy, 194, cy + 35); // stem down from the left edge of the ring
    c.rect(379, TOP, 380, TOP + 41);
    const heads = analyze(c).heads;
    expect(heads.length).toBe(1);
    const notes = notesOf(c);
    expect(notes.length).toBe(1);
    expect(notes[0].duration).toBe(960); // a half note, not a quarter
  });
});

describe('omr3 symbols: time signature digit on an outer line', () => {
  it('never commits to a hole-closed misread (6 / 8 / 9) for a numerator whose arc lies on the top line', () => {
    // a bold "2" whose top arc is drawn ON the first staff line (staff-line removal erases it) over a "4"
    const TWO = ['.####.', '#....#', '....#.', '..##..', '.#....', '######'];
    const FOUR = ['...#.', '..##.', '.#.#.', '#####', '...#.', '...#.'];
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    trebleClef(c, 48);
    TWO.forEach((row, ry) => [...row].forEach((ch, rx) => ch === '#' && c.rect(86 + rx * 3, TOP + ry * 3, 88 + rx * 3, TOP + 2 + ry * 3)));
    FOUR.forEach((row, ry) => [...row].forEach((ch, rx) => ch === '#' && c.rect(88 + rx * 3, TOP + 22 + ry * 3, 90 + rx * 3, TOP + 24 + ry * 3)));
    filledHead(c, 220, 0);
    c.rect(379, TOP, 380, TOP + 41);
    const s = analyze(c);
    // either the right signature or "unreadable / absent" (the assembler then infers the meter), never 6/4, 8/4 or 9/4
    expect([undefined, 2]).toContain(s.timeSig?.numerator);
  });
});

describe('omr3 symbols: digit classifier', () => {
  const grid = (rows: string[]) => {
    const h = rows.length;
    const w = rows[0].length;
    const g = new Uint8Array(w * h);
    rows.forEach((r, y) => [...r].forEach((ch, x) => (g[y * w + x] = ch === '#' ? 1 : 0)));
    return classifyDigit(g, w, h);
  };
  const scaled = (rows: string[], k: number) => rows.flatMap((r) => Array<string>(k).fill([...r].map((ch) => ch.repeat(k)).join('')));
  it('reads a bold 4 whose triangle was nicked, and a flat-topped 3', () => {
    expect(grid(scaled(['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 3))).toBe(4);
    expect(grid(scaled(['####.', '....#', '....#', '.###.', '....#', '#...#', '.###.'], 3))).toBe(3);
  });
});
