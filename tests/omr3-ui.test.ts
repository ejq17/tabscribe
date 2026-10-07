import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyScore } from '../src/core';

const recognizeScore = vi.fn();
vi.mock('../src/omr', () => ({
  renderPdfPages: vi.fn(async () => [{}]),
  imageToCanvas: vi.fn(async () => ({})),
  recognizeScore: (...a: unknown[]) => recognizeScore(...a),
}));

import { useStore } from '../src/store';

describe('guitar-octave setting', () => {
  beforeEach(() => {
    recognizeScore.mockReset();
    recognizeScore.mockResolvedValue(createEmptyScore({ title: 'x' }));
  });

  it('defaults to on', () => {
    expect(useStore.getState().settings.guitarOctave).toBe(true);
  });

  it('is passed to OMR as instrument', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' });
    await useStore.getState().loadFile(file);
    expect(recognizeScore.mock.calls[0][1].instrument).toBe('guitar');

    useStore.getState().setSettings({ guitarOctave: false });
    await useStore.getState().loadFile(file);
    expect(recognizeScore.mock.calls[1][1].instrument).toBe('concert');
  });

  it('persists to localStorage', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
    useStore.getState().setSettings({ guitarOctave: false });
    expect(Object.values(store).some((v) => JSON.parse(v).settings.guitarOctave === false)).toBe(true);
    vi.unstubAllGlobals();
  });
});
