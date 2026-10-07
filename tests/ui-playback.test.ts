import { describe, expect, it } from 'vitest';
import { createEmptyScore, type Score } from '../src/core';
import { useStore } from '../src/store';
import { activeAt, buildTimeline, normBox, tickAtPoint } from '../src/ui/followAlong';
import { measureClickTick, type MeasureLayout } from '../src/ui/tabLayout';

function scoreWithBoxes(): Score {
  const s = createEmptyScore({ title: 't' });
  s.tracks.push({
    id: 'g', name: 'Guitar', program: 25, isGuitarTarget: true,
    notes: [
      { id: 'a', pitch: 64, start: 0, duration: 480, velocity: 90, voice: 0 },
      { id: 'b', pitch: 60, start: 480, duration: 960, velocity: 90, voice: 0 },
      { id: 'c', pitch: 55, start: 960, duration: 480, velocity: 90, voice: 1 },
      { id: 'd', pitch: 55, start: 3840, duration: 480, velocity: 90, voice: 0 },
    ],
  });
  s.meta.omrBoxes = {
    a: [{ page: 0, x: 0.1, y: 0.1, w: 0.05, h: 0.05 }],
    b: [{ page: 0, x: 0.3, y: 0.1, w: 0.05, h: 0.05 }],
    c: [{ page: 0, x: 0.5, y: 0.1, w: 0.05, h: 0.05 }],
    d: [{ page: 1, x: 0.2, y: 0.6, w: 0.05, h: 0.05 }],
  } as never;
  return s;
}

describe('follow-along lookup', () => {
  const tl = buildTimeline(scoreWithBoxes());
  it('finds all notes sounding at a tick, including overlaps', () => {
    expect(activeAt(tl, 0).map((e) => e.noteId)).toEqual(['a']);
    expect(activeAt(tl, 479).map((e) => e.noteId)).toEqual(['a']);
    expect(activeAt(tl, 480).map((e) => e.noteId)).toEqual(['b']);
    expect(activeAt(tl, 1000).map((e) => e.noteId).sort()).toEqual(['b', 'c']);
    expect(activeAt(tl, 1440)).toEqual([]);
    expect(activeAt(tl, 3840)[0].page).toBe(1);
  });
  it('maps clicks on a page to a tick', () => {
    expect(tickAtPoint(tl, 0, 0.12, 0.12)).toBe(0); // inside box a
    expect(tickAtPoint(tl, 0, 0.45, 0.3)).toBe(960); // nearest by x in the row
    expect(tickAtPoint(tl, 1, 0.9, 0.1)).toBe(3840);
    expect(tickAtPoint(tl, 2, 0.5, 0.5)).toBeNull();
  });
  it('normalizes pixel boxes only when the page size is known', () => {
    expect(normBox({ page: 0, x: 100, y: 50, w: 20, h: 10 })).toBeNull();
    expect(normBox({ page: 0, x: 100, y: 50, w: 20, h: 10 }, { w: 1000, h: 500 })).toMatchObject({ x: 0.1, y: 0.1 });
  });
  it('adds a measure region for slash measures', () => {
    const s = scoreWithBoxes();
    s.meta.omrSlashMeasures = [{ index: 1, tick: 1440, length: 960 }];
    const t = buildTimeline(s);
    const a = activeAt(t, 2000);
    expect(a.length).toBe(1);
    expect(a[0].noteId).toBe('');
    expect(a[0].page).toBe(0);
  });
});

describe('tab click to tick', () => {
  const m = {
    measure: { index: 0, startTick: 0, endTick: 1920 },
    pts: [{ tick: 0, x: 100 }, { tick: 960, x: 200 }, { tick: 1920, x: 300 }],
  } as unknown as MeasureLayout;
  it('snaps to the 16th grid and clamps within the measure', () => {
    expect(measureClickTick(m, 200, 480)).toBe(960);
    expect(measureClickTick(m, 50, 480)).toBe(0);
    expect(measureClickTick(m, 999, 480)).toBe(1920 - 120);
    expect(measureClickTick(m, 151, 480) % 120).toBe(0);
  });
});

describe('playChords setting', () => {
  it('defaults on and persists', () => {
    expect(useStore.getState().settings.playChords).toBe(true);
    useStore.getState().setSettings({ playChords: false });
    expect(useStore.getState().settings.playChords).toBe(false);
    expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes('playChords'))!)!).settings.playChords).toBe(false);
    useStore.getState().setSettings({ playChords: true });
  });
});
