import { describe, it, expect } from 'vitest';
import { binarize, detectStaves, recognizeImageData, recognizeScore, preprocess } from '../src/omr';
import { classifyDigit } from '../src/omr/symbols';
import type { Score } from '../src/core';
import { Canvas, TOP, lineC, yStep, staff, barline, ledger, filledHead, hollowHead, sharp, trebleClef } from './fixtures/omr/synth';

function pitches(score: Score, voice?: number) {
  const notes = score.tracks.flatMap((t) => t.notes).filter((n) => voice === undefined || n.voice === voice);
  return notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
}

describe('omr preprocessing + staff detection', () => {
  it('binarizes with ink = 1 and detects staves', () => {
    const c = new Canvas(600, 260);
    staff(c);
    const b = binarize(c.img());
    expect(b.data[(TOP + 0) * 600 + 100]).toBe(1);
    expect(b.data[(TOP + 5) * 600 + 100]).toBe(0);
    const staves = detectStaves(b);
    expect(staves.length).toBe(1);
    expect(staves[0].staffSpace).toBeCloseTo(10, 0);
    expect(staves[0].lineThickness).toBe(2);
    expect(staves[0].lines[2]).toBeCloseTo(lineC(2), 0);
    expect(staves[0].left).toBeLessThanOrEqual(41);
    expect(staves[0].right).toBeGreaterThanOrEqual(579);
  });

  it('finds two systems on one page and deskews a slightly rotated page', () => {
    const c = new Canvas(600, 420);
    staff(c, 40, 580, 60);
    staff(c, 40, 580, 260);
    expect(detectStaves(binarize(c.img())).length).toBe(2);

    // Rotate by ~1° (nearest neighbour) and check deskew still yields 1 staff
    const s = new Canvas(800, 300);
    staff(s, 40, 760, 120);
    const r = new Canvas(800, 300);
    const ang = (1 * Math.PI) / 180;
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 800; x++) {
        const sx = (x - 400) * Math.cos(ang) - (y - 150) * Math.sin(ang) + 400;
        const sy = (x - 400) * Math.sin(ang) + (y - 150) * Math.cos(ang) + 150;
        const si = (Math.round(sy) * 800 + Math.round(sx)) * 4;
        if (sx >= 0 && sy >= 0 && sx < 800 && sy < 300 && s.data[si] === 0) r.set(x, y);
      }
    const p = preprocess(r.img());
    expect(Math.abs(p.transform.angle)).toBeGreaterThan(0);
    expect(detectStaves(p.binary).length).toBe(1);
  });
});

describe('omr pipeline on synthetic scores', () => {
  it('reads pitches and rhythms: quarters, half (hollow), whole (hollow, line through hole)', () => {
    const c = new Canvas(660, 260);
    staff(c, 40, 640);
    // measure 1: B4 C5 A4 G4 quarters
    filledHead(c, 100, 0);
    filledHead(c, 160, 1);
    filledHead(c, 220, -1, 'up');
    filledHead(c, 280, -2, 'up');
    barline(c, 330);
    // measure 2: E4 half (bottom line), G4 quarter, B4 quarter(stem down)
    hollowHead(c, 380, -4, 'up');
    filledHead(c, 450, -2, 'up');
    filledHead(c, 510, 0, 'down');
    barline(c, 550);
    // measure 3: whole note on line 3 (G4) with the line visible through the hole
    hollowHead(c, 590, -2, 'none', true);
    // final barline
    c.rect(625, TOP, 626, TOP + 41);
    const score = recognizeImageData([c.img()]);
    const notes = pitches(score);
    expect(score.meta.source).toBe('omr');
    expect(notes.map((n) => n.pitch)).toEqual([71, 72, 69, 67, 64, 67, 71, 67]);
    expect(notes.map((n) => n.start)).toEqual([0, 480, 960, 1440, 1920, 2880, 3360, 3840]);
    expect(notes.map((n) => n.duration)).toEqual([480, 480, 480, 480, 960, 480, 480, 1920]);
    expect(notes[0].spelling).toEqual({ step: 'B', alter: 0, octave: 4 });
    for (const n of notes) {
      expect(n.confidence).toBeGreaterThan(0);
      expect(n.confidence).toBeLessThanOrEqual(1);
    }
    const boxes = score.meta.omrBoxes as Record<string, { page: number; x: number; y: number; w: number; h: number }[]>;
    const b0 = boxes[notes[0].id][0];
    expect(b0.page).toBe(0);
    expect(b0.x).toBeLessThan(100);
    expect(b0.x + b0.w).toBeGreaterThan(100);
    expect(score.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
  });

  it('maps ledger-line notes (C4 below, A5 above) and bass clef default', () => {
    const c = new Canvas(400, 260);
    staff(c);
    // C4 is 6 steps below B4: step = -6 → below the staff on the first ledger line
    ledger(c, 100, lineC(4) + 10);
    filledHead(c, 100, -6, 'up');
    // A5 is step +5 → above the top line... top line is F5 (step 4), so A5 sits on first ledger above
    ledger(c, 160, lineC(0) - 10);
    filledHead(c, 160, 6, 'down');
    barline(c, 200);
    const treble = pitches(recognizeImageData([c.img()]));
    expect(treble.map((n) => n.pitch)).toEqual([60, 81]);
    const bass = pitches(recognizeImageData([c.img()], { defaultClef: 'bass' }));
    // bass: middle line D3 (50); step -6 → dia 22-6=16 = E2 (40); step +6 → dia 28 = C... 28 = octave 4 letter 0 = C4 (60)
    expect(bass.map((n) => n.pitch)).toEqual([40, 60]);
  });

  it('handles beams (eighths / sixteenths), a flag, and chords', () => {
    const c = new Canvas(700, 260);
    staff(c, 40, 680);
    // m1: two beamed eighths (stems up, B4 C5), then three quarters
    filledHead(c, 100, 0, 'up', 35);
    filledHead(c, 140, 1, 'up', 35);
    c.rect(105, yStep(0) - 35, 146, yStep(0) - 31); // beam spanning both stems (5 px thick)
    filledHead(c, 200, 0);
    filledHead(c, 260, 0);
    filledHead(c, 320, 0);
    barline(c, 360);
    // m2: four beamed sixteenths (two beams) then quarter and half
    for (let i = 0; i < 4; i++) filledHead(c, 400 + i * 32, 0, 'up', 35);
    c.rect(405, yStep(0) - 35, 405 + 3 * 32 + 1, yStep(0) - 31);
    c.rect(405, yStep(0) - 27, 405 + 3 * 32 + 1, yStep(0) - 23);
    filledHead(c, 540, 0);
    hollowHead(c, 600, 0, 'up');
    barline(c, 650);
    const score = recognizeImageData([c.img()]);
    const notes = pitches(score);
    expect(notes.map((n) => n.duration)).toEqual([240, 240, 480, 480, 480, 120, 120, 120, 120, 480, 960]);
    expect(notes.map((n) => n.start)).toEqual([0, 240, 480, 960, 1440, 1920, 2040, 2160, 2280, 2400, 2880]);
    expect(notes[1].pitch).toBe(72);
  });

  it('reads flagged eighths and a chord on one stem', () => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    // two flagged eighths (G4 stem up with a curved flag) then three quarters
    for (const x of [100, 140]) {
      filledHead(c, x, -2, 'up', 35);
      const top = yStep(-2) - 35;
      c.line(x + 7, top + 1, x + 20, top + 12, 5);
    }
    filledHead(c, 200, 0);
    filledHead(c, 260, 0);
    filledHead(c, 290, 0);
    barline(c, 320);
    // m2: whole measure of half chord: B4 + D5 on one stem (third), quarter rest ignored
    hollowHead(c, 370, 0, 'none');
    hollowHead(c, 370, 2, 'none');
    c.rect(376, yStep(2) - 35, 377, yStep(0));
    filledHead(c, 440, 0);
    filledHead(c, 480, 0);
    barline(c, 505);
    const score = recognizeImageData([c.img()]);
    const notes = pitches(score);
    expect(notes[0].duration).toBe(240);
    expect(notes[1].duration).toBe(240);
    // chord starts together
    const chord = notes.filter((n) => n.start === notes[5].start);
    expect(chord.length).toBe(2);
    expect(chord.map((n) => n.pitch).sort()).toEqual([71, 74]);
  });

  it('reads a clef, a one-sharp key signature, and a note accidental', () => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    trebleClef(c, 48);
    sharp(c, 88, lineC(0)); // F# key signature (top line F5)
    filledHead(c, 160, 4); // F5 → F#5 = 78
    filledHead(c, 220, -1); // A4 = 69
    sharp(c, 262, yStep(-2)); // accidental on G4 → G#4 = 68
    filledHead(c, 290, -2);
    filledHead(c, 340, -2); // G4 again within the measure keeps the sharp → 68
    barline(c, 380);
    filledHead(c, 420, -2); // new measure: G natural = 67
    const score = recognizeImageData([c.img()]);
    expect(score.keySignatures[0].fifths).toBe(1);
    const notes = pitches(score);
    expect(notes.map((n) => n.pitch)).toEqual([78, 69, 68, 68, 67]);
    expect(notes[2].spelling).toEqual({ step: 'G', alter: 1, octave: 4 });
    expect(score.meta.warnings?.some((w) => /clef/i.test(w))).toBeFalsy();
  });

  it('handles rests and scales an overfull measure, lowering confidence', () => {
    const c = new Canvas(520, 260);
    staff(c, 40, 500);
    // whole rest (hanging below line 2 from top, i.e. line index 1)
    c.rect(100, lineC(1) + 1, 112, lineC(1) + 5);
    barline(c, 150);
    // measure with half rest (sitting on the middle line) + quarter + quarter
    c.rect(180, lineC(2) - 5, 192, lineC(2));
    filledHead(c, 240, 0);
    filledHead(c, 300, 0);
    barline(c, 340);
    // overfull: five quarters in 4/4
    for (let i = 0; i < 5; i++) filledHead(c, 370 + i * 24, 0);
    barline(c, 495);
    const score = recognizeImageData([c.img()]);
    const notes = pitches(score);
    expect(notes[0].start).toBe(1920 + 960); // whole-measure rest, then a half rest
    expect(notes[0].duration).toBe(480);
    expect(notes[1].start).toBe(1920 + 1440);
    // 5 quarters squeezed into 1920 ticks
    const last = notes.slice(-5);
    expect(last[0].duration).toBeLessThan(480);
    expect(last[0].confidence!).toBeLessThan(0.8);
    expect(score.meta.warnings?.some((w) => /did not add up/.test(w))).toBe(true);
  });

  it('builds a grand staff into one track with two voices and aligned measures', () => {
    const c = new Canvas(520, 420);
    staff(c, 60, 500, 60);
    staff(c, 60, 500, 140);
    // system barline + brace-ish bar at the left connecting both staves
    c.rect(60, 60, 61, 181);
    c.rect(46, 60, 49, 181);
    const t0 = 60;
    const yT = (step: number) => t0 + 20.5 - step * 5;
    // treble: B4 whole-measure of 4 quarters at the same pitch; bass: D3 half + half
    for (let i = 0; i < 4; i++) {
      const cy = yT(0);
      c.ellipse(120 + i * 70, cy, 6.5, 5);
      c.rect(120 + i * 70 + 5, cy - 35, 120 + i * 70 + 6, cy);
    }
    c.rect(400, 60, 401, 101);
    const yB = (step: number) => 140 + 20.5 - step * 5;
    for (let i = 0; i < 2; i++) {
      const cy = yB(0);
      const cx = 120 + i * 140;
      c.ellipse(cx, cy, 6.5, 5);
      c.ellipse(cx, cy, 4.5, 2.8, false);
      c.rect(cx + 5, cy - 35, cx + 6, cy);
    }
    c.rect(400, 140, 401, 181);
    const score = recognizeImageData([c.img()]);
    expect(score.tracks.length).toBe(1);
    const treble = pitches(score, 0);
    const bass = pitches(score, 1);
    expect(treble.map((n) => n.pitch)).toEqual([71, 71, 71, 71]);
    expect(treble.map((n) => n.start)).toEqual([0, 480, 960, 1440]);
    expect(bass.map((n) => n.pitch)).toEqual([50, 50]); // bass clef: middle line = D3
    expect(bass.map((n) => n.start)).toEqual([0, 960]);
    expect(bass.map((n) => n.duration)).toEqual([960, 960]);
  });

  it('marks a tie between equal pitches across a barline', () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    filledHead(c, 80, 0);
    filledHead(c, 130, 0);
    filledHead(c, 180, 0);
    filledHead(c, 230, 0);
    barline(c, 270);
    filledHead(c, 310, 0);
    // tie arc from last head of m1 to the first head of m2 (drawn above, stems up on the right so arc is below)
    const cy = lineC(3) + 2; // inside the space between lines 3 and 4
    for (let x = 230; x <= 310; x++) {
      const t = (x - 230) / 80;
      c.rect(x, cy + 4 * Math.sin(Math.PI * t), x, cy + 4 * Math.sin(Math.PI * t) + 1);
    }
    const notes = pitches(recognizeImageData([c.img()]));
    expect(notes.length).toBe(5);
    expect(notes[4].tiedFromPrevious).toBe(true);
    expect(notes[3].tiedFromPrevious).toBeFalsy();
  });

  it('warns on pages without staves', () => {
    const c = new Canvas(200, 200);
    const score = recognizeImageData([c.img()]);
    expect(score.tracks.length).toBe(0);
    expect(score.meta.warnings?.some((w) => /no staves/i.test(w))).toBe(true);
  });
});

describe('time signature digits', () => {
  const bmp = (rows: string[], k = 4) => {
    const h = rows.length * k;
    const w = rows[0].length * k;
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = rows[Math.floor(y / k)][Math.floor(x / k)] === '#' ? 1 : 0;
    return { d, w, h };
  };
  it('classifies hand-drawn digits', () => {
    const digits: Record<number, string[]> = {
      4: ['...###', '..#.##', '.#..##', '#...##', '######', '....##', '....##'],
      3: ['.####.', '#....#', '.....#', '..###.', '.....#', '#....#', '.####.'],
      2: ['.####.', '#....#', '.....#', '....#.', '...#..', '..#...', '######'],
      6: ['..###.', '.#....', '#.....', '#####.', '#....#', '#....#', '.####.'],
      8: ['.####.', '#....#', '#....#', '.####.', '#....#', '#....#', '.####.'],
    };
    for (const [k, rows] of Object.entries(digits)) {
      const { d, w, h } = bmp(rows);
      expect(classifyDigit(d, w, h)).toBe(Number(k));
    }
  });
});

describe('recognizeScore (canvas wrapper)', () => {
  it('adds sourcePages and omrBoxes using canvas-like objects (inline path, no Worker)', async () => {
    const c = new Canvas(400, 260);
    staff(c, 40, 380);
    filledHead(c, 100, 0);
    filledHead(c, 160, 1);
    barline(c, 330);
    const fake = {
      width: 400,
      height: 260,
      getContext: () => ({ getImageData: () => ({ width: 400, height: 260, data: new Uint8ClampedArray(c.data) }) }),
      toDataURL: (type: string) => `data:${type};base64,AAAA`,
    } as unknown as HTMLCanvasElement;
    const stages: string[] = [];
    const score = await recognizeScore([fake], { onProgress: (p) => stages.push(p.stage) });
    expect(score.meta.source).toBe('omr');
    expect(score.meta.sourcePages).toEqual(['data:image/jpeg;base64,AAAA']);
    expect(pitches(score).map((n) => n.pitch)).toEqual([71, 72]);
    expect(Object.keys(score.meta.omrBoxes as object).length).toBe(2);
    expect(stages.length).toBeGreaterThan(0);
  });
});
