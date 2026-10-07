import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createEmptyScore } from '../src/core/score';
import type { Note, Score } from '../src/core/score';
import { importMusicXml } from '../src/importers/musicxml';
import { analyzePage, assembleScore } from '../src/omr/assemble';
import type { RawImage } from '../src/omr/types';
import {
  bestOffset, extractTruthMeasures, matchNotes, normalizeQuality, prf, sanitizeXml, rootPitchClass, scorePiece,
} from '../scripts/omr-bench/metrics';

const PPQ = 480;
function mk(spec: { m: number; beat: number; pitch: number; dur?: number }[], meta: Record<string, unknown> = {}, ts = 4): Score {
  const s = createEmptyScore();
  s.timeSignatures = [{ tick: 0, numerator: ts, denominator: 4 }];
  const notes: Note[] = spec.map((n, i) => ({
    id: 'n' + i, pitch: n.pitch, start: (n.m * ts + n.beat) * PPQ, duration: (n.dur ?? 1) * PPQ, velocity: 90, voice: 0,
  }));
  s.tracks = [{ id: 't', name: 't', program: 0, notes }];
  Object.assign(s.meta, meta);
  return s;
}
const truthExtras = (n: number, over: Partial<ReturnType<typeof extractTruthMeasures>['measures'][number]>[] = []) => ({
  clefs: ['G2'],
  measures: Array.from({ length: n }, (_, i) => ({
    index: i, startTick: i * 4 * PPQ, lengthTick: 4 * PPQ, fifths: 0, numerator: 4, denominator: 4, chords: [], slash: false, ...(over[i] ?? {}),
  })),
});

describe('metrics', () => {
  it('prf basics', () => {
    expect(prf(2, 4, 2)).toMatchObject({ precision: 1, recall: 0.5 });
    expect(prf(0, 0, 0).f1).toBe(1); // nothing to find, nothing found
    expect(prf(0, 3, 0).f1).toBe(0);
    expect(sanitizeXml('<a>x & y &amp; z</a>')).toBe('<a>x &amp; y &amp; z</a>');
  });

  it('matchNotes is one-to-one and respects tolerance and pitch', () => {
    const t = [{ pitch: 60, start: 0, duration: 480 }, { pitch: 60, start: 480, duration: 480 }];
    const r = [{ pitch: 60, start: 10, duration: 480 }, { pitch: 62, start: 480, duration: 480 }];
    expect(matchNotes(t, r, 60)).toBe(1);
    expect(matchNotes(t, [r[0], r[0]], 60)).toBe(1);
    expect(matchNotes(t, r, 5)).toBe(0);
  });

  it('bestOffset finds a constant shift', () => {
    const t = [{ pitch: 60, start: 1920, duration: 1 }, { pitch: 62, start: 2400, duration: 1 }, { pitch: 64, start: 2880, duration: 1 }];
    const r = t.map((n) => ({ ...n, start: n.start - 1920 }));
    expect(bestOffset(t, r, 60)).toBe(1920);
  });

  it('perfect recognition scores 1 everywhere', () => {
    const spec = [{ m: 0, beat: 0, pitch: 60 }, { m: 0, beat: 1, pitch: 62 }, { m: 1, beat: 0, pitch: 64, dur: 2 }];
    const m = scorePiece(mk(spec), mk(spec, { omrMeasures: 2 }), truthExtras(2));
    expect(m.alignment).toBe('measure');
    expect(m.pitch.f1).toBe(1);
    expect(m.full.f1).toBe(1);
    expect(m.measures).toMatchObject({ correct: true, absError: 0 });
    expect(m.key.acc).toBe(1);
    expect(m.time.acc).toBe(1);
    expect(m.chords.exact).toBeNull();
    expect(m.slash.recall).toBeNull();
    expect(m.clef.acc).toBeNull();
  });

  it('wrong duration lowers full F1 only; wrong pitch lowers both', () => {
    const t = mk([{ m: 0, beat: 0, pitch: 60 }, { m: 0, beat: 1, pitch: 62 }]);
    const r = mk([{ m: 0, beat: 0, pitch: 60, dur: 2 }, { m: 0, beat: 1, pitch: 63 }], { omrMeasures: 1 });
    const m = scorePiece(t, r, truthExtras(1));
    expect(m.pitch.matched).toBe(1);
    expect(m.full.matched).toBe(0);
  });

  it('falls back to global alignment with offset when measure counts differ', () => {
    const t = mk([{ m: 2, beat: 0, pitch: 60 }, { m: 2, beat: 1, pitch: 62 }, { m: 3, beat: 0, pitch: 64 }]);
    const r = mk([{ m: 0, beat: 0, pitch: 60 }, { m: 0, beat: 1, pitch: 62 }, { m: 1, beat: 0, pitch: 64 }], { omrMeasures: 2 });
    const m = scorePiece(t, r, truthExtras(4));
    expect(m.alignment).toBe('global');
    expect(m.pitch.f1).toBe(1);
    expect(m.measures).toMatchObject({ correct: false, absError: 2 });
  });

  it('key and time accuracy are per measure after applying changes', () => {
    const t = mk([{ m: 0, beat: 0, pitch: 60 }]);
    const r = mk([{ m: 0, beat: 0, pitch: 60 }], { omrMeasures: 4 });
    r.keySignatures = [{ tick: 0, fifths: 0, mode: 'major' }, { tick: 12 * PPQ, fifths: 2, mode: 'major' }];
    const ex = truthExtras(4, [{}, {}, { fifths: 2 }, { fifths: 2 }]);
    const m = scorePiece(t, r, ex);
    expect(m.key).toMatchObject({ ok: 3, total: 4 }); // measure 3 is the only mismatch (change lands one bar late)
    expect(m.time.acc).toBe(1);
  });

  it('chord comparison lights up when the OMR emits labels', () => {
    const t = mk([{ m: 0, beat: 0, pitch: 60 }]);
    const ex = truthExtras(3, [{ chords: [{ root: 'G', quality: 'm' }] }, { chords: [{ root: 'Bb', quality: '' }] }, { chords: [{ root: 'D', quality: '7b9' }] }]);
    const r = mk([{ m: 0, beat: 0, pitch: 60 }], {
      omrMeasures: 3,
      omrChords: [
        { measureIndex: 0, chord: { root: 'G', quality: 'min' } }, // exact (min == m)
        { measureIndex: 1, chord: { root: 'A#', quality: 'm' } }, // root only
        { measureIndex: 2, chord: { root: 'E', quality: '7' } }, // wrong
      ],
    });
    const m = scorePiece(t, r, ex);
    expect(m.chords.exact).toBeCloseTo(1 / 3);
    expect(m.chords.root).toBeCloseTo(2 / 3);
  });

  it('slash measures are scored from meta.omrSlashMeasures', () => {
    const t = mk([{ m: 0, beat: 0, pitch: 60 }]);
    const ex = truthExtras(4, [{}, { slash: true }, { slash: true }, {}]);
    const r = mk([{ m: 0, beat: 0, pitch: 60 }], { omrMeasures: 4, omrSlashMeasures: [{ index: 2 }, { index: 4 }] });
    const m = scorePiece(t, r, ex);
    expect(m.slash).toMatchObject({ truth: 2, hit: 1, falsePos: 1, recall: 0.5 });
  });

  it('chord helpers normalize spellings', () => {
    expect(rootPitchClass('Bb')).toBe(10);
    expect(rootPitchClass('A#')).toBe(10);
    expect(rootPitchClass('B♭')).toBe(10);
    expect(rootPitchClass('H')).toBeUndefined();
    expect(normalizeQuality('min')).toBe('m');
    expect(normalizeQuality('M7')).toBe('maj7');
    expect(normalizeQuality('Maj')).toBe('');
  });

  it('extractTruthMeasures reads chords, slash regions, pickups and key/time', () => {
    const xml = `<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">
      <measure number="0" implicit="yes"><attributes><divisions>1</divisions><key><fifths>-2</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure>
      <measure number="1"><harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind text="maj7">major-seventh</kind></harmony>
        <attributes><measure-style><slash type="start"/></measure-style></attributes>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>3</duration></note></measure>
      <measure number="2"><attributes><measure-style><slash type="stop"/></measure-style></attributes>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>3</duration></note></measure>
      <measure number="3"><note><pitch><step>D</step><octave>4</octave></pitch><duration>3</duration></note></measure>
    </part></score-partwise>`;
    const e = extractTruthMeasures(xml, PPQ);
    expect(e.measures.map((m) => m.lengthTick / PPQ)).toEqual([1, 3, 3, 3]);
    expect(e.measures.map((m) => m.slash)).toEqual([false, true, true, false]);
    expect(e.measures[1].chords).toEqual([{ root: 'Bb', quality: 'maj7' }]);
    expect(e.measures[3]).toMatchObject({ fifths: -2, numerator: 3, denominator: 4, startTick: 7 * PPQ });
    expect(e.clefs).toEqual(['G2']);
  });
});

const SKIP = !!process.env.OMR_CORPUS_SKIP;
const CORPUS = resolve(__dirname, 'fixtures/omr/corpus');

async function pagesOf(id: string, n: number): Promise<RawImage[]> {
  const out: RawImage[] = [];
  for (let i = 1; i <= n; i++) {
    const img = await loadImage(readFileSync(join(CORPUS, id, `page-${i}.png`)));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    out.push({ width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) });
  }
  return out;
}

describe.skipIf(SKIP)('omr corpus (slow)', () => {
  for (const id of ['greensleeves', 'londonderry-air', 'after-youve-gone']) {
    it(`${id}: smoke floors on the clean render`, async () => {
      const xml = sanitizeXml(readFileSync(join(CORPUS, id, 'score.musicxml'), 'utf8'));
      const truth = importMusicXml(xml);
      const extras = extractTruthMeasures(xml, truth.ppq);
      const pages = await pagesOf(id, 1);
      const results = pages.map((p, i) => analyzePage(p, i));
      const score = assembleScore(results);
      const m = scorePiece(truth, score, extras);
      expect(results.reduce((s, r) => s + r.staves.length, 0)).toBeGreaterThan(0);
      expect(m.measures.recognized).toBeGreaterThan(m.measures.truth * 0.8);
      expect(m.measures.recognized).toBeLessThan(m.measures.truth * 1.2);
      expect(m.pitch.f1).toBeGreaterThan(0.2);
    }, 20000);
  }
});
