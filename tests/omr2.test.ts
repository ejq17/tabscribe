import { describe, it, expect } from 'vitest';
import { recognizeImageData } from '../src/omr';
import type { Score } from '../src/core';
import { Canvas, TOP, lineC, yStep, staff, barline, filledHead, trebleClef } from './fixtures/omr/synth';

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
});
