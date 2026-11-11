import { describe, expect, it } from 'vitest';
import { isConfidentLabel, unreliableChordPages, MIN_PAGE_LABELS } from '../src/omr/chordreliability';

type L = { repaired?: boolean; ocrConf?: number };
const clean = (n: number, ocrConf = 0.9): L[] => Array.from({ length: n }, () => ({ repaired: false, ocrConf }));
const repaired = (n: number): L[] => Array.from({ length: n }, () => ({ repaired: true, ocrConf: 0.5 }));
const unsure = (n: number): L[] => Array.from({ length: n }, () => ({ repaired: false, ocrConf: 0 }));

describe('chord reliability rule', () => {
  it('a label is confident only when unrepaired and OCR confidence is not near zero', () => {
    expect(isConfidentLabel({ repaired: false, ocrConf: 0.8 })).toBe(true);
    expect(isConfidentLabel({ repaired: true, ocrConf: 0.99 })).toBe(false);
    expect(isConfidentLabel({ repaired: false, ocrConf: 0.05 })).toBe(false);
  });

  it('keeps a clean-font page', () => {
    expect(unreliableChordPages([{ page: 0, labels: [...clean(15), ...unsure(1)] }]).size).toBe(0);
  });

  it('drops a page where most labels needed repair or had no OCR confidence', () => {
    const bad = unreliableChordPages([{ page: 0, labels: [...clean(7), ...repaired(2), ...unsure(8)] }, { page: 1, labels: clean(10) }]);
    expect([...bad]).toEqual([0]);
  });

  it('is decided per page', () => {
    const bad = unreliableChordPages([{ page: 0, labels: clean(8) }, { page: 1, labels: [...clean(4), ...unsure(4)] }, { page: 2, labels: clean(5) }]);
    expect([...bad]).toEqual([1]);
  });

  it('drops a page just under the threshold and keeps one exactly at it', () => {
    expect(unreliableChordPages([{ page: 0, labels: [...clean(5), ...unsure(2)] }]).size).toBe(1); // 5/7
    expect(unreliableChordPages([{ page: 0, labels: [...clean(3), ...unsure(1)] }]).size).toBe(0); // 3/4 sits exactly on the threshold: kept
  });

  it('judges pages with too few labels together', () => {
    expect(MIN_PAGE_LABELS).toBeGreaterThan(2);
    expect([...unreliableChordPages([{ page: 0, labels: unsure(2) }, { page: 1, labels: unsure(1) }])].sort()).toEqual([0, 1]);
    expect(unreliableChordPages([{ page: 0, labels: clean(2) }, { page: 1, labels: clean(1) }]).size).toBe(0);
    // a clean pooled share rescues a lone unsure label on another small page
    expect(unreliableChordPages([{ page: 0, labels: clean(3) }, { page: 1, labels: unsure(1) }]).size).toBe(0);
  });

  it('never judges labels without OCR diagnostics (text layer, Claude reader)', () => {
    expect(unreliableChordPages([{ page: 0, labels: Array.from({ length: 10 }, () => ({})) }]).size).toBe(0);
    // text-layer labels do not dilute or rescue an OCR page
    expect([...unreliableChordPages([{ page: 0, labels: [...Array.from({ length: 20 }, () => ({})), ...unsure(6)] }])]).toEqual([0]);
  });
});
