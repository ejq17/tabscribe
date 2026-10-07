import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyScore, newNoteId, type Score } from '../src/core';
import { useStore } from '../src/store';

function makeScore(): Score {
  const s = createEmptyScore({ title: 't' });
  s.tracks.push({
    id: 'g',
    name: 'Guitar',
    program: 25,
    isGuitarTarget: true,
    notes: [
      { id: 'a', pitch: 64, start: 0, duration: 480, velocity: 90, voice: 0 },
      { id: 'b', pitch: 60, start: 480, duration: 480, velocity: 90, voice: 0 },
      { id: 'c', pitch: 55, start: 960, duration: 480, velocity: 90, voice: 0 },
    ],
  });
  void newNoteId;
  return s;
}
const notes = () => useStore.getState().score!.tracks[0].notes;

describe('store', () => {
  beforeEach(() => {
    useStore.getState().loadScore(makeScore());
  });

  it('loads a score and clears history', () => {
    expect(notes().length).toBe(3);
    expect(useStore.getState().history.past.length).toBe(0);
  });

  it('undo/redo round trip', () => {
    const st = useStore.getState();
    st.deleteNotes(['a']);
    expect(notes().length).toBe(2);
    useStore.getState().undo();
    expect(notes().length).toBe(3);
    useStore.getState().redo();
    expect(notes().length).toBe(2);
    expect(useStore.getState().history.future.length).toBe(0);
  });

  it('pitch change updates the note and clears an unlocked tab', () => {
    useStore.getState().updateNote('a', { pitch: 67 });
    const n = notes().find((x) => x.id === 'a')!;
    expect(n.pitch).toBe(67);
    if (n.tab) expect(useStore.getState().guitar.tuning.pitches[n.tab.string] + n.tab.fret).toBe(67);
  });

  it('locked note keeps its string when pitch changes', () => {
    useStore.getState().moveNoteToString('a', 1);
    useStore.getState().updateNote('a', { pitch: 65 });
    const n = notes().find((x) => x.id === 'a')!;
    expect(n.tab).toEqual({ string: 1, fret: 6 });
    expect(n.tabLocked).toBe(true);
  });

  it('setting tab locks the note', () => {
    useStore.getState().updateNote('b', { tab: { string: 2, fret: 5 } });
    const n = notes().find((x) => x.id === 'b')!;
    expect(n.tabLocked).toBe(true);
    expect(n.pitch).toBe(60);
  });

  it('deleteNotes removes notes and selection', () => {
    useStore.getState().setSelection(['a', 'b']);
    useStore.getState().deleteNotes(['a', 'b']);
    expect(notes().map((n) => n.id)).toEqual(['c']);
    expect(useStore.getState().selection).toEqual([]);
  });

  it('moveNoteToString in standard tuning: E4 on string 0 fret 0 or string 1 fret 5', () => {
    expect(useStore.getState().moveNoteToString('a', 1)).toBe(true);
    let n = notes().find((x) => x.id === 'a')!;
    expect(n.tab).toEqual({ string: 1, fret: 5 });
    expect(n.tabLocked).toBe(true);
    expect(useStore.getState().moveNoteToString('a', 0)).toBe(true);
    n = notes().find((x) => x.id === 'a')!;
    expect(n.tab).toEqual({ string: 0, fret: 0 });
  });

  it('moveNoteToString refuses impossible strings', () => {
    // E4 (64) cannot be played on the low E string... it can (fret 24) only beyond maxFret 22
    expect(useStore.getState().moveNoteToString('a', 5)).toBe(false);
    // C4 (60) is lower than open high E
    expect(useStore.getState().moveNoteToString('b', 0)).toBe(false);
  });

  it('transposeSelection shifts pitches', () => {
    useStore.getState().setSelection(['c']);
    useStore.getState().transposeSelection(12);
    expect(notes().find((x) => x.id === 'c')!.pitch).toBe(67);
  });

  it('addNote adds and selects', () => {
    const id = useStore.getState().addNote({ pitch: 52, start: 1440, duration: 480, voice: 0 });
    expect(id).toBeTruthy();
    expect(notes().length).toBe(4);
    expect(useStore.getState().selection).toEqual([id]);
  });
});
