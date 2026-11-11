import { describe, expect, it } from 'vitest';
import { analyzePage, recognizeImageData } from '../src/omr/assemble';
import { Canvas, TOP, barline, filledHead, staff, trebleClef, yStep } from './fixtures/omr/synth';

const flat = (c: Canvas, x: number, cy: number) => {
  c.rect(x, cy - 24, x + 1, cy + 6);
  c.ellipse(x + 5, cy + 1, 4.5, 4.5);
  c.ellipse(x + 5, cy + 1, 1.6, 1.8, false);
  c.rect(x, cy - 6, x + 1, cy + 6);
};
/** clef + 3 flats, then a barline right behind them (the engraving style that used to make a phantom measure) */
function head(c: Canvas, leadingBar: boolean) {
  staff(c, 40, 540);
  trebleClef(c, 48);
  [0, 2, -1].forEach((step, i) => flat(c, 78 + i * 11, yStep(step)));
  if (leadingBar) barline(c, 125);
}
/** a thin slanted stroke (a rhythm slash drawn with a thin pen) */
const slash = (c: Canvas, x: number) => c.line(x, yStep(0) + 9, x + 9, yStep(0) - 9, 2);

describe('omr5 structure: leading barline, thin slashes, H-bar rests', () => {
  it('a barline right after the clef / key signature is not a measure', () => {
    const c = new Canvas(600, 260);
    head(c, true);
    filledHead(c, 190, 0);
    barline(c, 260);
    filledHead(c, 330, 1);
    barline(c, 539);
    const s = analyzePage(c.img(), 0).symbols[0];
    expect(s.barlines).toHaveLength(2);
    expect(s.musicStart).toBeGreaterThan(120);
    expect(recognizeImageData([c.img()]).meta.omrMeasures).toBe(2);
  });

  it('the same two bars without the leading barline still count two', () => {
    const c = new Canvas(600, 260);
    head(c, false);
    filledHead(c, 190, 0);
    barline(c, 260);
    filledHead(c, 330, 1);
    barline(c, 539);
    expect(recognizeImageData([c.img()]).meta.omrMeasures).toBe(2);
  });

  it('a first bar that holds a whole rest behind the signature is kept', () => {
    const c = new Canvas(600, 260);
    head(c, true);
    c.rect(180, TOP + 10, 200, TOP + 15); // whole rest hanging from the 4th line
    barline(c, 260);
    filledHead(c, 330, 1);
    barline(c, 539);
    expect(recognizeImageData([c.img()]).meta.omrMeasures).toBe(2);
  });

  it('four thin slashes per bar are slash notation, not eighth rests', () => {
    const c = new Canvas(600, 260);
    head(c, true);
    for (const bx of [140, 330]) for (let k = 0; k < 4; k++) slash(c, bx + 10 + k * 35);
    barline(c, 320);
    barline(c, 539);
    const page = analyzePage(c.img(), 0);
    expect(page.symbols[0].slashes?.length).toBe(8);
    expect(page.symbols[0].rests.filter((r) => r.kind === 'eighth')).toHaveLength(0);
    const score = recognizeImageData([c.img()]);
    expect(score.meta.omrSlashMeasures).toHaveLength(2);
    expect(score.tracks.flatMap((t) => t.notes)).toHaveLength(0);
  });

  it('an H-bar multi-measure rest (short thick bar with end caps) is found', () => {
    const c = new Canvas(600, 260);
    head(c, true);
    const mid = yStep(0);
    c.rect(200, mid - 7, 240, mid - 1); // the bar, between the 2nd and 3rd line
    c.rect(200, mid - 14, 202, mid + 7); // caps
    c.rect(238, mid - 14, 240, mid + 7);
    barline(c, 300);
    barline(c, 539);
    const s = analyzePage(c.img(), 0).symbols[0];
    expect(s.multiRests).toHaveLength(1);
  });
});
