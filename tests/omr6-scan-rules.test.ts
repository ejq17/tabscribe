import { describe, expect, it } from 'vitest';
import { analyzePage, recognizeImageData } from '../src/omr/assemble';
import { classifyDigit } from '../src/omr/symbols';
import { parseChordText } from '../src/omr/chordtext/parse';
import { mergeWords, tempoPhrases, type TextWord } from '../src/omr/chordtext';
import { Canvas, TOP, barline, filledHead, staff, trebleClef, yStep } from './fixtures/omr/synth';

const flat = (c: Canvas, x: number, cy: number) => {
  c.rect(x, cy - 24, x + 1, cy + 6);
  c.ellipse(x + 5, cy + 1, 4.5, 4.5);
  c.ellipse(x + 5, cy + 1, 1.6, 1.8, false);
  c.rect(x, cy - 6, x + 1, cy + 6);
};
const slash = (c: Canvas, x: number) => c.line(x, yStep(0) + 9, x + 9, yStep(0) - 9, 2);
function head(c: Canvas, flats = 3, x1 = 580) {
  staff(c, 40, x1);
  trebleClef(c, 48);
  [0, 2, -1].slice(0, flats).forEach((step, i) => flat(c, 78 + i * 11, yStep(step)));
}

/** ASCII glyph -> tight 0/1 bitmap for classifyDigit */
function bitmap(rows: string[]): { d: Uint8Array; w: number; h: number } {
  const w = rows[0].length;
  const d = new Uint8Array(w * rows.length);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { d[y * w + x] = ch === '#' ? 1 : 0; }));
  return { d, w, h: rows.length };
}
const read = (rows: string[]) => { const b = bitmap(rows); return classifyDigit(b.d, b.w, b.h); };

describe('omr6: hand-lettered multi-measure-rest numerals (glyph bitmaps, 1 px = 1 pixel at 2.5x, staff space ~11 px)', () => {
  it('a 4 with a heavy tapering crossbar and a short triangular counter', () => {
    expect(read([
      '.........#.....',
      '.........##....',
      '........###....',
      '.......####....',
      '.......####....',
      '......#####....',
      '.....######....',
      '.....######....',
      '....#######....',
      '....#######....',
      '...####.###....',
      '...####.###....',
      '...###..###....',
      '..####...##....',
      '..###....##....',
      '..###....##....',
      '.###.....######',
      '.###....#######',
      '###############',
      '###############',
      '###############',
      '###############',
      '#############..',
      '#########.###..',
      '.#####....###..',
      '..........###..',
      '..........###..',
      '...........##..',
      '...........##..',
      '...........##..',
      '...........##..',
    ])).toBe(4);
  });

  it('a 2 with no flat base: one diagonal stroke in the lower middle, flick at the right of the base', () => {
    expect(read([
      '......##......',
      '....#####.....',
      '...#######....',
      '..########....',
      '.#########....',
      '.#########....',
      '.#########....',
      '####...###....',
      '###....###....',
      '###...###.....',
      '###...###.....',
      '###...###.....',
      '###..####.....',
      '###..####.....',
      '###..###......',
      '###.####......',
      '##..####......',
      '...####.......',
      '...####.......',
      '...###........',
      '...###........',
      '..####.......#',
      '..###......###',
      '..###.....####',
      '..###...######',
      '.####.########',
      '.############.',
      '.###########..',
      '.##########...',
      '..########....',
      '..######......',
    ])).toBe(2);
  });

  it('a bold 3 whose two bowls line up on the right is not an open-top 4', () => {
    expect(read([
      '....########....',
      '...###..######..',
      '..###.....#####.',
      '.#####....#####.',
      '.######...#####.',
      '.######...#####.',
      '.######...#####.',
      '..####....#####.',
      '...#....######..',
      '......######....',
      '.....########...',
      '........#######.',
      '..###.....######',
      '.#####.....#####',
      '######.....#####',
      '######.....#####',
      '######....######',
      '.#####....#####.',
      '..###....#####..',
      '...###..#####...',
      '.....#####......',
    ])).toBe(3);
  });

  it('a 3 with a notch between its arcs and an arc that starts right of the left edge is not a 5', () => {
    expect(read([
      '....####....',
      '...#####....',
      '..#######...',
      '.########...',
      '.########...',
      '.########...',
      '####..###...',
      '###...###...',
      '###..###....',
      '##...###....',
      '##..####....',
      '##..###.....',
      '##.####.....',
      '...#######..',
      '..#########.',
      '.###########',
      '.###########',
      '.###########',
      '.#####...###',
      '.###......##',
      '.##.......##',
      '.........###',
      '........####',
      '....#...####',
      '...###.####.',
      '...########.',
      '..########..',
      '..########..',
      '...######...',
      '...#####....',
      '....##......',
    ])).toBe(3);
  });
});

describe('omr6: scanned guitar-part structure rules', () => {
  it('a slanted thick bar with tall end caps (hand-lettered multi-measure rest) is found', () => {
    const c = new Canvas(620, 260);
    head(c, 2);
    const mid = yStep(0);
    c.line(250, mid + 3, 300, mid - 3, 10); // slanted bar, 10 px thick (= one space)
    c.rect(249, TOP - 4, 251, TOP + 45); // caps reach past both outer lines
    c.rect(299, TOP - 4, 301, TOP + 45);
    barline(c, 200);
    barline(c, 360);
    barline(c, 540);
    const s = analyzePage(c.img(), 0).symbols[0];
    expect(s.multiRests).toHaveLength(1);
    expect(s.multiRests[0].x1 - s.multiRests[0].x0).toBeGreaterThan(40);
  });

  it('the cell between a repeat sign and the end of a long signature prefix is not a measure, even beyond 9.5 spaces from the staff start', () => {
    const c = new Canvas(660, 260);
    head(c, 3, 640);
    barline(c, 168); // |: far right of the staff start: 128 px = 12.8 spaces, ~60 px behind the key signature
    barline(c, 170);
    filledHead(c, 260, 0);
    barline(c, 380);
    filledHead(c, 470, 1);
    barline(c, 639);
    const score = recognizeImageData([c.img()]);
    expect(score.meta.omrMeasures).toBe(2);
  });

  it('a last cell of chord slashes whose closing barline is missing is still a measure', () => {
    const c = new Canvas(600, 260);
    head(c, 3, 580);
    for (let k = 0; k < 4; k++) slash(c, 150 + k * 35);
    barline(c, 330);
    for (let k = 0; k < 4; k++) slash(c, 350 + k * 35); // no barline at the staff end
    const score = recognizeImageData([c.img()]);
    expect(score.meta.omrMeasures).toBe(2);
    expect(score.meta.omrSlashMeasures).toHaveLength(2);
  });

  it('a rehearsal-mark box above the staff start does not swallow the key signature into the clef', () => {
    const c = new Canvas(620, 260);
    head(c, 3);
    // box 36 px wide, 22 px tall, sitting just above the staff and touching the first flat's stem and the clef top
    c.rect(52, TOP - 52, 88, TOP - 50);
    c.rect(52, TOP - 30, 88, TOP - 28);
    c.rect(52, TOP - 52, 54, TOP - 28);
    c.rect(86, TOP - 52, 88, TOP - 28);
    filledHead(c, 200, 0);
    barline(c, 300);
    filledHead(c, 400, 1);
    barline(c, 579);
    const s = analyzePage(c.img(), 0).symbols[0];
    expect(s.clefDetected).toBe(true);
    expect(s.keyFifths).toBe(-3);
  });
});

describe('omr6: key stability, chord-text repairs, tempo phrases', () => {
  it('systems whose clef was not found carry the key of the system before them instead of reading C major', () => {
    const withKey = new Canvas(620, 260);
    head(withKey, 3);
    filledHead(withKey, 200, 0);
    barline(withKey, 300);
    filledHead(withKey, 400, 1);
    barline(withKey, 579);
    const bare = () => {
      const c = new Canvas(620, 260);
      staff(c, 40, 580); // no clef, no key signature on this line
      filledHead(c, 200, 0);
      barline(c, 300);
      filledHead(c, 400, 1);
      barline(c, 579);
      return c;
    };
    const score = recognizeImageData([withKey.img(), bare().img(), bare().img()]);
    expect(score.keySignatures).toHaveLength(1);
    expect(score.keySignatures[0].fifths).toBe(-3);
  });

  it('a chord starts with a letter: a leading digit is repaired to the look-alike root', () => {
    expect(parseChordText('07')?.text).toBe('C7');
    expect(parseChordText('87')?.text).toBe('B7');
    expect(parseChordText('G7')?.text).toBe('G7'); // a clean read is untouched
  });

  it('the words of one tempo line become one phrase; a word on another line or far away does not join', () => {
    const w = (x0: number, x1: number, y0: number): TextWord => ({ x0, x1, y0, y1: y0 + 20, w: x1 - x0 + 1, h: 21, ink: new Uint8Array((x1 - x0 + 1) * 21).fill(1), boxed: false });
    const d = 11;
    const ph = tempoPhrases([w(100, 140, 50), w(150, 200, 51), w(214, 224, 49), w(240, 270, 50), w(150, 200, 120), w(600, 640, 50)], d);
    expect(ph.map((p) => p.length)).toEqual([4, 1, 1]);
    const m = mergeWords(ph[0]);
    expect(m.x0).toBe(100);
    expect(m.x1).toBe(270);
    expect(m.w).toBe(171);
  });
});
