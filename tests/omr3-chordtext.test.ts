// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Canvas, staff as drawStaff, barline } from './fixtures/omr/synth';
import { binarize } from '../src/omr/preprocess';
import { detectStaves } from '../src/omr/staves';
import { parseChordText, classifyNonChord, splitChordWord, findTextWords, assignMeasures, readChordText, configureChordOcr, disposeChordOcr } from '../src/omr/chordtext';
import { encodeGrayPng } from '../src/omr/chordtext/png';

const t = (s: string) => parseChordText(s)?.text ?? null;

describe('chord text parser', () => {
  it.each([
    ['Bbmaj7', 'Bbmaj7'], ['Ebm6/F', 'Ebm6/F'], ['D7b9b5', 'D7b9b5'], ['Gmadd2', 'Gmadd2'], ['C9#11', 'C9#11'], ['F6/9', 'F6/9'],
    ['Am11', 'Am11'], ['G13b9', 'G13b9'], ['D7#9#5', 'D7#9#5'], ['Cmaj9/G', 'Cmaj9/G'], ['Bb/F', 'Bb/F'], ['F', 'F'], ['C', 'C'],
    ['Cm7b5', 'Cm7b5'], ['Csus4', 'Csus4'], ['Cdim7', 'Cdim7'], ['F#m7', 'F#m7'], ['Ab9', 'Ab9'], ['Bm11', 'Bm11'],
  ])('parses %s', (raw, want) => expect(t(raw)).toBe(want));

  it('normalizes alternative spellings', () => {
    expect(t('C-7')).toBe('Cm7');
    expect(t('CΔ7')).toBe('Cmaj7');
    expect(t('B♭maj7')).toBe('Bbmaj7');
    expect(t('Cø')).toBe('Cm7b5');
    expect(t('C°7')).toBe('Cdim7');
    expect(t('C+')).toBe('Caug');
    expect(t('Cmin9')).toBe('Cm9');
    expect(t('Cmi11')).toBe('Cm11');
    expect(t('E(b9)')).toBe('Eb9'); // parens dropped: ambiguous but still a legal chord
  });

  it('structure of parsed chord', () => {
    expect(parseChordText('Ebm6/Bb')!.chord).toEqual({ root: 'Eb', quality: 'm6', bass: 'Bb' });
    expect(parseChordText('D7b9b5')!.chord).toEqual({ root: 'D', quality: '7b9b5' });
  });

  it('repairs OCR corruption', () => {
    expect(t('D74945')).toBe('D7b9b5');
    expect(t('D769')).toBe('D7b9');
    expect(t('Ebm#6/Bb')).toBe('Ebm6/Bb');
    expect(t('Cma)7')).toBe('Cmaj7');
    expect(t('D7#94#5')).toBe('D7#9#5');
    expect(t('C9411')).toBe('C9#11');
    expect(t('E74985')).toBe('E7b9b5');
    expect(t('Dp7')).toBe('Db7');
    const rep = parseChordText('D769')!;
    expect(rep.confidence).toBeLessThan(1);
    expect(parseChordText('D7b9')!.confidence).toBe(1);
  });

  it('rejects non-chords', () => {
    for (const s of ['', 'Rubato', 'rit.', 'mf', 'cresc.', 'a tempo', '47', 'xyz', 'Slightly', 'H7', 'C3', 'Cm3x']) expect(t(s)).toBeNull();
  });

  it('classifies tempo / rehearsal text', () => {
    expect(classifyNonChord('Rubato')).toBe('tempo');
    expect(classifyNonChord('rit.')).toBe('tempo');
    expect(classifyNonChord('a tempo')).toBe('tempo');
    expect(classifyNonChord('mf')).toBe('tempo');
    expect(classifyNonChord('cresc.')).toBe('tempo');
    expect(classifyNonChord('17')).toBe('rehearsal');
    expect(classifyNonChord('33')).toBe('rehearsal');
  });

  it('splits merged words', () => {
    expect(splitChordWord('Em9Am9')!.map((p) => p.text)).toEqual(['Em9', 'Am9']);
    expect(splitChordWord('Cmaj7')).toBeNull();
    expect(splitChordWord('Ebm6/F')).toBeNull();
  });
});

describe('blob finder (synthetic)', () => {
  function page() {
    const c = new Canvas(700, 260);
    drawStaff(c, 40, 640, 150); // lines at y=150..191, space 10
    barline(c, 300, 150);
    return c;
  }
  const words = (c: Canvas) => {
    const b = binarize(c.img());
    const st = detectStaves(b);
    expect(st.length).toBe(1);
    return { st: st[0], b, w: findTextWords(b, st[0]) };
  };
  // text-like glyph blocks: 10x14 px "letters" with a hole so they are not solid bars
  const glyph = (c: Canvas, x: number, y: number) => { c.rect(x, y, x + 7, y + 13); c.rect(x + 2, y + 3, x + 5, y + 10, false); };

  it('finds one word per cluster, separated by wide gaps', () => {
    const c = page();
    for (let i = 0; i < 4; i++) glyph(c, 100 + i * 10, 100);
    for (let i = 0; i < 3; i++) glyph(c, 350 + i * 10, 100);
    const { w } = words(c);
    expect(w.length).toBe(2);
    expect(w[0].x0).toBe(100);
    expect(w[1].x0).toBe(350);
    expect(w[0].w).toBeGreaterThan(30);
  });

  it('ignores stems, noteheads touching the staff, and the clef area', () => {
    const c = page();
    c.rect(200, 100, 201, 150); // stem standing on the top line
    c.ellipse(190, 150, 6, 5); // notehead on the top line
    glyph(c, 45, 120); // inside the clef area (left + 3.5 ss)
    const { w } = words(c);
    expect(w.length).toBe(0);
  });

  it('flags boxed rehearsal marks', () => {
    const c = page();
    // frame 24x20 with a digit-like blob inside
    c.rect(400, 100, 424, 101); c.rect(400, 119, 424, 120); c.rect(400, 100, 401, 120); c.rect(423, 100, 424, 120);
    glyph(c, 408, 104);
    const { w } = words(c);
    expect(w.length).toBe(1);
    expect(w[0].boxed).toBe(true);
  });

  it('ignores tiny marks (articulations)', () => {
    const c = page();
    c.rect(200, 125, 205, 128);
    expect(words(c).w.length).toBe(0);
  });

  it('respects limitTop', () => {
    const c = page();
    glyph(c, 120, 110);
    const b = binarize(c.img());
    const st = detectStaves(b)[0];
    expect(findTextWords(b, st).length).toBe(1);
    expect(findTextWords(b, st, { limitTop: 140 }).length).toBe(0);
  });
});

describe('helpers', () => {
  it('assigns measures by barline ranges', () => {
    const labels = [100, 400, 700].map((x) => ({ x, text: 'C', chord: { root: 'C', quality: '' }, confidence: 1 }));
    const r = assignMeasures(labels, [300, 600], 4);
    expect(r.map((l) => l.measureIndex)).toEqual([4, 5, 6]);
  });

  it('encodes a valid PNG', () => {
    const png = encodeGrayPng(3, 2, new Uint8Array([0, 255, 0, 255, 0, 255]));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

// Network/WASM integration: RUN_TESSERACT=1 npx vitest run tests/omr3-chordtext.test.ts
describe.skipIf(!process.env.RUN_TESSERACT)('tesseract integration', () => {
  it('OCRs chord text rendered with a system font', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const cv = createCanvas(900, 300);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 300);
    g.fillStyle = '#000';
    for (let i = 0; i < 5; i++) g.fillRect(40, 200 + 12 * i, 820, 2);
    g.font = '19px serif';
    g.fillText('Bbmaj7', 120, 175);
    g.fillText('Ebm6/F', 420, 175);
    g.fillText('D7b9', 700, 175);
    const id = g.getImageData(0, 0, 900, 300);
    const bin = binarize({ width: 900, height: 300, data: id.data as unknown as Uint8ClampedArray });
    const st = detectStaves(bin);
    expect(st.length).toBe(1);
    configureChordOcr({ cachePath: process.env.TESS_CACHE ?? '/tmp' });
    try {
      const r = await readChordText(bin, st[0]);
      const got = r.chords.map((c) => c.text);
      expect(got.length).toBeGreaterThanOrEqual(2);
      expect(got).toContain('Bbmaj7');
      expect(got).toContain('D7b9');
    } finally {
      await disposeChordOcr();
    }
  }, 120000);
});
