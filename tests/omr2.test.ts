import { describe, it, expect } from 'vitest';
import { recognizeImageData } from '../src/omr';
import type { Score } from '../src/core';
import { Canvas, TOP, lineC, yStep, staff, barline, filledHead, hollowHead, trebleClef, sharp } from './fixtures/omr/synth';

const notesOf = (s: Score) => s.tracks.flatMap((t) => t.notes).sort((a, b) => a.start - b.start || b.pitch - a.pitch);

/** Flat sign: thin stem, small filled bulb with a hole at the lower right. */
function flat(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 24, x + 1, cy + 6);
  c.ellipse(x + 5, cy + 1, 4.5, 4.5);
  c.ellipse(x + 5, cy + 1, 1.6, 1.8, false);
  c.rect(x, cy - 6, x + 1, cy + 6);
}

/** Thin elliptical ring head (like real engraving); the staff line may pass through the hole. */
function ringHead(c: Canvas, cx: number, step: number, stem: 'up' | 'none', keepLine: boolean) {
  const cy = yStep(step);
  c.ellipse(cx, cy, 7, 5.5);
  c.ellipse(cx, cy, 5, 3.4, false);
  if (keepLine) for (let i = 0; i < 5; i++) if (Math.abs(lineC(i) - cy) < 3) c.rect(cx - 5, lineC(i) - 0.5, cx + 5, lineC(i) + 0.5);
  if (stem === 'up') c.rect(cx + 6, cy - 35, cx + 7, cy);
}

describe('omr: real-engraving robustness (synthetic)', () => {
  it('reads a four-flat key signature and applies it to the next note', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    trebleClef(c, 48);
    flat(c, 100, yStep(0)); // Bb
    flat(c, 115, yStep(3)); // Eb
    flat(c, 130, yStep(-1)); // Ab
    flat(c, 145, yStep(2)); // Db
    filledHead(c, 230, 0); // B4 -> Bb4 = 70
    barline(c, 300);
    c.rect(379, TOP, 380, TOP + 41);
    const score = recognizeImageData([c.img()]);
    expect(score.keySignatures[0].fifths).toBe(-4);
    expect(notesOf(score).map((n) => n.pitch)).toEqual([70]);
  });

  it('recognises common time and cut time glyphs', () => {
    for (const cut of [false, true]) {
      const c = new Canvas(400, 260);
      staff(c, 40, 380);
      trebleClef(c, 48);
      const mid = yStep(0);
      c.ellipse(90, mid, 6, 10);
      c.ellipse(90, mid, 3.6, 7.6, false);
      c.rect(92, mid - 5, 98, mid + 5, false);
      if (cut) c.rect(89, mid - 17, 90, mid + 17);
      filledHead(c, 200, 0);
      c.rect(379, TOP, 380, TOP + 41);
      const score = recognizeImageData([c.img()]);
      expect(score.timeSignatures[0]).toMatchObject(cut ? { numerator: 2, denominator: 2 } : { numerator: 4, denominator: 4 });
      expect(notesOf(score).length).toBe(1);
    }
  });

  it('detects thin hollow rings with the staff line through the hole (half with stem, whole without)', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    ringHead(c, 100, -2, 'up', true); // G4 half on the 2nd line
    barline(c, 160);
    ringHead(c, 220, 0, 'none', true); // B4 whole on the middle line
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.pitch)).toEqual([67, 71]);
    expect(notes.map((n) => n.duration)).toEqual([960, 1920]);
  });

  it('treats a measure with only a whole rest as empty', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    c.rect(100, lineC(1) + 1, 114, lineC(1) + 5);
    barline(c, 160);
    filledHead(c, 220, 0);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.length).toBe(1);
    expect(notes[0].start).toBe(1920);
  });

  it('advances two measures for a multi-measure rest numbered 2', () => {
    const c = new Canvas(440, 260);
    staff(c, 40, 420);
    c.rect(70, TOP + 19, 290, TOP + 22);
    c.rect(70, yStep(0) - 7, 71, yStep(0) + 7);
    c.rect(289, yStep(0) - 7, 290, yStep(0) + 7);
    // digit "2" above the staff (bitmap scaled x2)
    const two = ['.####.', '#....#', '.....#', '....#.', '...#..', '..#...', '######'];
    two.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') c.rect(172 + rx * 2, TOP - 34 + ry * 2, 173 + rx * 2, TOP - 33 + ry * 2);
    });
    barline(c, 310);
    filledHead(c, 360, 0);
    c.rect(419, TOP, 420, TOP + 41);
    const score = recognizeImageData([c.img()]);
    const notes = notesOf(score);
    expect(notes.length).toBe(1);
    expect(notes[0].start).toBe(3840);
    expect(score.meta.warnings?.some((w) => /multi-measure/.test(w))).toBeFalsy();
  });

  it('never turns four slash marks into notes', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    const mid = yStep(0);
    for (const x of [100, 160, 220, 280]) c.line(x - 9, mid + 10, x + 9, mid - 10, 7);
    barline(c, 330);
    c.rect(399, TOP, 400, TOP + 41);
    expect(notesOf(recognizeImageData([c.img()])).length).toBe(0);
  });

  it('quantizes rescaled durations to the 16th grid', () => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    filledHead(c, 100, 0);
    filledHead(c, 160, 0);
    ringHead(c, 240, 0, 'up', false);
    ringHead(c, 320, 0, 'up', false);
    c.rect(499, TOP, 500, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.length).toBe(4);
    for (const n of notes) expect(n.duration % 120 === 0 || n.duration % 80 === 0).toBe(true);
    for (const n of notes) expect(n.start % 120 === 0 || n.start % 80 === 0).toBe(true);
    const last = notes[3];
    expect(last.start + last.duration).toBeLessThanOrEqual(1920);
  });
  it('reads a stemmed hollow half note with the staff line through it as a half (not a quarter)', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    ringHead(c, 100, 0, 'up', true); // B4 half on the middle line
    filledHead(c, 180, 0);
    filledHead(c, 240, 0);
    barline(c, 300);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.duration)).toEqual([960, 480, 480]);
    expect(notes.map((n) => n.start)).toEqual([0, 960, 1440]);
  });

  it('reads a dotted eighth + sixteenth pair (360 + 120) with the secondary beam only on the short stem', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    filledHead(c, 100, 0, 'up', 35);
    filledHead(c, 140, 0, 'up', 35);
    c.rect(105, yStep(0) - 35, 146, yStep(0) - 31); // primary beam over both stems
    c.rect(135, yStep(0) - 27, 146, yStep(0) - 23); // partial secondary beam on the second stem only
    c.rect(113, yStep(0) - 7, 116, yStep(0) - 4); // augmentation dot (in the space above the line) right of the first head
    filledHead(c, 200, 0);
    hollowHead(c, 260, 0, 'up');
    barline(c, 320);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.duration)).toEqual([360, 120, 480, 960]);
    expect(notes.map((n) => n.start)).toEqual([0, 360, 480, 960]);
  });

  it('tells a one-flag eighth from two-flag sixteenths', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    const flagged = (x: number, flags: number) => {
      filledHead(c, x, -2, 'up', 35);
      const top = yStep(-2) - 35;
      for (let f = 0; f < flags; f++) c.line(x + 7, top + 2 + f * 10, x + 19, top + 10 + f * 10, 5);
    };
    flagged(100, 1);
    flagged(150, 2);
    flagged(200, 2);
    filledHead(c, 260, 0);
    hollowHead(c, 320, 0, 'up');
    barline(c, 370);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.duration)).toEqual([240, 120, 120, 480, 960]);
  });

  it('gives an eighth rest and a quarter rest their exact standard durations', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    const mid = yStep(0);
    // eighth rest: small blob with a diagonal tail (about 2 staff spaces tall)
    c.ellipse(100, mid - 8, 3, 3);
    c.line(103, mid - 6, 96, mid + 10, 3);
    // quarter rest: hooked zig-zag about 3 staff spaces tall
    const y0 = mid - 14;
    c.line(150, y0, 162, y0 + 8, 4);
    c.line(162, y0 + 8, 152, y0 + 16, 4);
    c.line(152, y0 + 16, 162, y0 + 24, 4);
    c.ellipse(155, y0 + 27, 4, 3);
    hollowHead(c, 220, 0, 'up'); // half note after 240 + 480
    filledHead(c, 300, 0, 'up', 35); // flagged eighth
    c.line(307, mid - 34, 319, mid - 24, 5);
    barline(c, 350);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.length).toBe(2);
    expect(notes[0].start).toBe(720);
    expect(notes[0].duration).toBe(960);
    expect(notes[1].start).toBe(1680);
    expect(notes[1].duration).toBe(240);
  });

  it('counts beams per stem: a partial secondary beam leaves the third stem an eighth', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    for (const x of [100, 140, 180]) filledHead(c, x, 0, 'up', 35);
    c.rect(105, yStep(0) - 35, 186, yStep(0) - 31); // primary beam across all three
    c.rect(105, yStep(0) - 27, 146, yStep(0) - 23); // secondary beam only between stems 1 and 2
    filledHead(c, 240, 0);
    hollowHead(c, 300, 0, 'up');
    barline(c, 360);
    c.rect(399, TOP, 400, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.duration)).toEqual([120, 120, 240, 480, 960]);
    expect(notes.map((n) => n.start)).toEqual([0, 120, 240, 480, 960]);
  });
});

/** Natural sign: two thin verticals, the right one lower, joined by a small parallelogram. */
function natural(c: Canvas, x: number, cy: number) {
  c.rect(x, cy - 14, x + 1, cy + 6);
  c.rect(x + 7, cy - 6, x + 8, cy + 14);
  c.rect(x + 1, cy - 8, x + 7, cy - 6);
  c.rect(x + 1, cy + 4, x + 7, cy + 6);
}

/** 5x7 bitmap digit scaled x2, top-left at (x, y). */
function digit(c: Canvas, rows: string[], x: number, y: number) {
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') c.rect(x + rx * 2, y + ry * 2, x + rx * 2 + 1, y + ry * 2 + 1);
  });
}
const THREE = ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'];

/** A thin arc (2 px) that starts and ends touching the heads' lower edges and bows downwards. */
function lowerArc(c: Canvas, x0: number, y0: number, x1: number, y1: number, bow: number) {
  for (let x = x0; x <= x1; x++) {
    const t = (x - x0) / (x1 - x0);
    const y = y0 + (y1 - y0) * t + bow * Math.sin(Math.PI * t);
    c.rect(x, y, x, y + 1);
  }
}

describe('omr: ties, accidentals, tuplets and multi-measure rests (synthetic)', () => {
  it('ties two equal-pitch heads joined by an arc merged into the notehead outlines', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    const cy = yStep(0);
    filledHead(c, 100, 0);
    filledHead(c, 200, 0);
    lowerArc(c, 104, cy + 4, 196, cy + 4, 9); // starts inside both heads: one connected component
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.pitch)).toEqual([71, 71]);
    expect(notes[0].tiedFromPrevious).toBeFalsy();
    expect(notes[1].tiedFromPrevious).toBe(true);
  });

  it('does not tie a slur between two different pitches, nor two equal pitches without an arc', () => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    filledHead(c, 100, 0);
    filledHead(c, 200, 2); // D5
    lowerArc(c, 104, yStep(0) + 4, 196, yStep(2) + 4, 8);
    filledHead(c, 300, 0);
    filledHead(c, 400, 0); // same pitch, no arc
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.length).toBe(4);
    expect(notes.map((n) => !!n.tiedFromPrevious)).toEqual([false, false, false, false]);
  });

  it('lets a natural sign cancel a key-signature flat', () => {
    const c = new Canvas(420, 260);
    staff(c, 40, 400);
    trebleClef(c, 48);
    flat(c, 100, yStep(0)); // Bb
    flat(c, 115, yStep(3)); // Eb
    flat(c, 130, yStep(-1)); // Ab
    flat(c, 145, yStep(2)); // Db
    natural(c, 205, yStep(0));
    filledHead(c, 240, 0); // B natural
    filledHead(c, 300, 0); // the natural lasts until the barline: still B natural
    barline(c, 340);
    filledHead(c, 380, 0); // next bar: Bb
    const score = recognizeImageData([c.img()]);
    expect(score.keySignatures[0].fifths).toBe(-4);
    expect(notesOf(score).map((n) => n.pitch)).toEqual([71, 71, 70]);
  });

  it('applies a sharp sign to the following note', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    trebleClef(c, 48);
    sharp(c, 170, yStep(1));
    filledHead(c, 205, 1); // C5 -> C#5
    filledHead(c, 270, 1); // still C#5 (same bar)
    barline(c, 330);
    filledHead(c, 360, 1); // next bar: C5
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.map((n) => n.pitch)).toEqual([73, 73, 72]);
  });

  it('reads a quarter-note triplet bracket with a "3" as three notes of 320 ticks', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    const ly = TOP - 30;
    c.rect(88, ly, 142, ly + 1); // left half of the bracket
    c.rect(88, ly, 89, ly + 10); // left tick
    c.rect(162, ly, 216, ly + 1); // right half
    c.rect(215, ly, 216, ly + 10); // right tick
    digit(c, THREE, 147, ly - 6);
    for (const x of [100, 150, 200]) filledHead(c, x, 0);
    c.rect(379, TOP, 380, TOP + 41);
    const notes = notesOf(recognizeImageData([c.img()]));
    expect(notes.length).toBe(3);
    expect(notes.map((n) => n.duration)).toEqual([320, 320, 320]);
    expect(notes.map((n) => n.start)).toEqual([0, 320, 640]);
  });

  it('expands a multi-measure rest numbered 3 into three empty measures', () => {
    const c = new Canvas(440, 260);
    staff(c, 40, 420);
    c.rect(70, TOP + 19, 290, TOP + 22);
    c.rect(70, yStep(0) - 7, 71, yStep(0) + 7);
    c.rect(289, yStep(0) - 7, 290, yStep(0) + 7);
    digit(c, THREE, 172, TOP - 34);
    barline(c, 310);
    filledHead(c, 360, 0);
    c.rect(419, TOP, 420, TOP + 41);
    const score = recognizeImageData([c.img()]);
    const notes = notesOf(score);
    expect(notes.length).toBe(1);
    expect(notes[0].start).toBe(3 * 1920);
    expect(score.meta.warnings?.some((w) => /multi-measure/.test(w))).toBeFalsy();
  });

  it('names the measure when a multi-measure rest count cannot be read', () => {
    const c = new Canvas(440, 260);
    staff(c, 40, 420);
    filledHead(c, 100, 0);
    barline(c, 160);
    c.rect(190, TOP + 19, 400, TOP + 22);
    c.rect(190, yStep(0) - 7, 191, yStep(0) + 7);
    c.rect(399, yStep(0) - 7, 400, yStep(0) + 7);
    c.rect(419, TOP, 420, TOP + 41);
    const score = recognizeImageData([c.img()]);
    expect(score.meta.warnings?.some((w) => /multi-measure rest at measure 2/.test(w))).toBe(true);
  });
});
