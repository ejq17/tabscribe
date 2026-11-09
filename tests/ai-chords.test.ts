import { beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createCanvas } from '@napi-rs/canvas';
import { createEmptyScore, type OmrChord, type OmrSystem, type Score } from '../src/core';
import { mapClaudeChords, maybeReadChordsWithClaude, readChordsWithClaude, type ClaudeCaller } from '../src/ai/claudeChords';
import { renderStrip, MAX_STRIP_WIDTH } from '../src/ai/strip';
import { useAiSettings } from '../src/ai/settings';

const PPQ = 480;
const factory = (w: number, h: number) => createCanvas(w, h) as never;

/** a system on page `page` with `n` 4/4 measures starting at measure `first`, spanning x 100..(100 + 400 n) */
function system(page: number, first: number, n: number, y = 300): OmrSystem {
  return {
    page,
    staffTop: y,
    staffBottom: y + 40,
    staffSpace: 10,
    left: 100,
    right: 100 + 400 * n,
    firstMeasure: first,
    measureCount: n,
    cells: Array.from({ length: n }, (_, i) => ({
      x0: 100 + 400 * i,
      x1: 100 + 400 * (i + 1),
      measure: first + i,
      tick: (first + i) * 4 * PPQ,
      length: 4 * PPQ,
      beatTicks: PPQ,
    })),
  };
}

function ocrChord(measure: number, text: string): OmrChord {
  return { measure, tick: measure * 4 * PPQ, text, chord: { root: text[0], quality: text.slice(1) }, confidence: 0.5 };
}

function scoreWith(systems: OmrSystem[], ocr: OmrChord[] = []): Score {
  const s = createEmptyScore({ source: 'omr' });
  s.meta.omrSystems = systems;
  if (ocr.length) s.meta.omrChords = ocr;
  return s;
}

const pages = [createCanvas(3000, 1000), createCanvas(3000, 1000)] as never[];

function pngWidth(b64: string): number {
  const bytes = Buffer.from(b64, 'base64');
  return bytes.readUInt32BE(16);
}

describe('strip renderer', () => {
  it('maps 4 measures and stays within 1568 px', async () => {
    const sys = system(0, 8, 4);
    sys.right = 2900; // wide system: needs downscaling
    const strip = await renderStrip(pages[0], sys, factory);
    expect(strip).toBeDefined();
    expect(strip!.measures).toHaveLength(4);
    expect(strip!.measures.map((m) => m.number)).toEqual([1, 2, 3, 4]);
    expect(strip!.measures.map((m) => m.measure)).toEqual([8, 9, 10, 11]);
    expect(strip!.png.length).toBeGreaterThan(100);
    expect(strip!.width).toBeLessThanOrEqual(MAX_STRIP_WIDTH);
    expect(pngWidth(strip!.png)).toBe(strip!.width);
  });
});

describe('response mapping', () => {
  const strip = { measures: system(0, 8, 4).cells.map((c, i) => ({ ...c, number: i + 1 })) };
  it('lands on the right measure and beat, drops junk and out-of-range measures', () => {
    const out = mapClaudeChords(strip, [
      { measure: 2, beat: 3, symbol: 'Bbmaj7' },
      { measure: 1, beat: 1, symbol: 'rit.' },
      { measure: 9, beat: 1, symbol: 'C' },
      { measure: 3, beat: 1, symbol: 'C6/9' },
      { measure: 4, beat: 1, symbol: 'F#ø' },
    ]);
    expect(out.map((c) => c.text)).toEqual(['Bbmaj7', 'C6/9', 'F#m7b5']);
    expect(out[0]).toMatchObject({ measure: 9, tick: 9 * 4 * PPQ + 2 * PPQ, chord: { root: 'Bb' } });
    expect(out[1].measure).toBe(10);
    expect(out[2].measure).toBe(11);
  });
});

describe('fallback', () => {
  const sysA = system(0, 0, 2);
  const sysB = system(0, 2, 3, 600);
  const sysC = system(1, 5, 4);
  const ocr = [ocrChord(0, 'C'), ocrChord(2, 'F'), ocrChord(6, 'G')];
  const good: ClaudeCaller = async () => ({ chords: [{ measure: 1, beat: 1, symbol: 'Dm7' }] });

  it('a bad key keeps OCR chords and adds exactly one warning', async () => {
    const auth = Anthropic.APIError.generate(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
    const caller = vi.fn<ClaudeCaller>(async () => {
      throw auth;
    });
    const s = scoreWith([sysA, sysB, sysC], ocr);
    await readChordsWithClaude(s, pages, { caller, canvasFactory: factory });
    expect(s.meta.omrChords).toEqual(ocr);
    expect(s.meta.warnings).toHaveLength(1);
    expect(s.meta.warnings![0]).toMatch(/API key was rejected/);
  });

  it('a CORS-forbidden org is reported as such', async () => {
    const e = Anthropic.APIError.generate(401, { error: { type: 'authentication_error', message: 'CORS requests are not allowed for this Organization' } }, 'CORS requests are not allowed for this Organization', new Headers());
    const s = scoreWith([sysA], ocr);
    await readChordsWithClaude(s, pages, { caller: async () => { throw e; }, canvasFactory: factory });
    expect(s.meta.warnings).toHaveLength(1);
    expect(s.meta.warnings![0]).toMatch(/does not allow requests from a browser/);
  });

  it('a rate limit on one system leaves the other systems Claude results in place', async () => {
    const rate = Anthropic.APIError.generate(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
    const caller: ClaudeCaller = async (png, n) => {
      if (n === 3) throw rate; // sysB
      return good(png, n);
    };
    const s = scoreWith([sysA, sysB, sysC], ocr);
    await readChordsWithClaude(s, pages, { caller, canvasFactory: factory });
    const texts = s.meta.omrChords!.map((c) => `${c.measure}:${c.text}`);
    expect(texts).toContain('0:Dm7'); // sysA replaced OCR C
    expect(texts).not.toContain('0:C');
    expect(texts).toContain('2:F'); // sysB kept its OCR chord
    expect(texts).toContain('5:Dm7'); // sysC replaced OCR G
    expect(texts).not.toContain('6:G');
    expect(s.meta.warnings).toHaveLength(1);
    expect(s.meta.warnings![0]).toMatch(/1 of 3 systems/);
  });

  it('reports progress and runs at most 3 systems at once', async () => {
    let live = 0;
    let max = 0;
    const caller: ClaudeCaller = async () => {
      live++;
      max = Math.max(max, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { chords: [] };
    };
    const onProgress = vi.fn();
    const s = scoreWith([0, 1, 2, 3, 4].map((i) => system(0, i * 2, 2, 100 + i * 100)));
    await readChordsWithClaude(s, pages, { caller, canvasFactory: factory, onProgress });
    expect(max).toBeLessThanOrEqual(3);
    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({ stage: 'Reading chord symbols with Claude', fraction: 1 });
  });
});

describe('disabled', () => {
  beforeEach(() => useAiSettings.getState().set({ enabled: false, apiKey: '' }));
  it('never calls the caller when disabled (or when there is no key)', async () => {
    const caller = vi.fn<ClaudeCaller>(async () => ({ chords: [] }));
    const s = scoreWith([system(0, 0, 2)], [ocrChord(0, 'C')]);
    useAiSettings.getState().set({ enabled: false, apiKey: 'sk-test' });
    await maybeReadChordsWithClaude(s, pages, { caller });
    useAiSettings.getState().set({ enabled: true, apiKey: '' });
    await maybeReadChordsWithClaude(s, pages, { caller });
    expect(caller).not.toHaveBeenCalled();
    expect(s.meta.omrChords).toEqual([ocrChord(0, 'C')]);
    expect(s.meta.warnings).toBeUndefined();
  });
});
