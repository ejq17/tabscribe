import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyScore, type Score } from '../src/core';
import { exportProject, importFile, importProject } from '../src/importers';
import { startAutosave, useStore } from '../src/store';
import * as lib from '../src/store/library';

function makeScore(title = 't'): Score {
  const s = createEmptyScore({ title });
  s.keySignatures = [{ tick: 0, fifths: -2, mode: 'major' }];
  s.meta.sourcePages = ['data:image/jpeg;base64,' + 'A'.repeat(200_000)];
  s.tracks.push({
    id: 'g', name: 'Guitar', program: 25, isGuitarTarget: true,
    notes: [
      { id: 'a', pitch: 64, start: 0, duration: 480, velocity: 90, voice: 0 },
      { id: 'b', pitch: 60, start: 480, duration: 480, velocity: 90, voice: 0 },
    ],
  });
  return s;
}

async function clearAll() {
  for (const e of await lib.listEntries()) await lib.deleteEntry(e.id);
}

describe('library', () => {
  beforeEach(clearAll);

  it('saves, lists, opens, renames, duplicates, deletes', async () => {
    const score = makeScore();
    const a = await lib.saveEntry({ id: 'one', name: 'First', score });
    expect(a.createdAt).toBe(a.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    await lib.saveEntry({ id: 'two', name: 'Second', score: makeScore('b') });
    expect((await lib.listEntries()).map((e) => e.id)).toEqual(['two', 'one']);
    expect((await lib.listEntries())[0]).not.toHaveProperty('score');

    const opened = await lib.getEntry('one');
    expect(opened?.score).toEqual(score);
    expect(opened?.score.meta.sourcePages?.[0].length).toBeGreaterThan(200_000);

    await lib.renameEntry('one', 'Renamed');
    expect((await lib.getEntry('one'))?.name).toBe('Renamed');

    const dup = await lib.duplicateEntry('one');
    expect(dup?.name).toBe('Renamed (copy)');
    expect(dup?.id).not.toBe('one');
    expect((await lib.getEntry(dup!.id))?.score).toEqual(score);

    await lib.deleteEntry('one');
    expect(await lib.getEntry('one')).toBeNull();
    expect(await lib.listEntries()).toHaveLength(2);
  });

  it('saves a multi-MB scan', async () => {
    const s = makeScore();
    s.meta.sourcePages = Array.from({ length: 5 }, () => 'data:image/jpeg;base64,' + 'B'.repeat(1_000_000));
    await lib.saveEntry({ id: 'big', name: 'Big', score: s });
    expect((await lib.getEntry('big'))?.score.meta.sourcePages).toHaveLength(5);
  });
});

describe('autosave', () => {
  let stop: () => void;
  beforeEach(async () => {
    await clearAll();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useStore.getState().detachLibrary();
    useStore.getState().loadScore(makeScore('auto'));
    stop = startAutosave(1000);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('creates an entry, then debounces edits into one save', async () => {
    await useStore.getState().saveAs('Untitled – x.pdf');
    const id = useStore.getState().libraryId!;
    expect(id).toBeTruthy();
    const spy = vi.spyOn(lib, 'saveEntry');

    useStore.getState().updateNote('a', { pitch: 67 });
    useStore.getState().updateNote('a', { pitch: 69 });
    expect(useStore.getState().saveStatus).toBe('saving');
    await vi.advanceTimersByTimeAsync(900);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(useStore.getState().saveStatus).toBe('saved'));
    expect(spy).toHaveBeenCalledTimes(1);

    const saved = await lib.getEntry(id);
    expect(saved?.score.tracks[0].notes.find((n) => n.id === 'a')?.pitch).toBe(69);
    spy.mockRestore();
  });

  it('does not save when no library entry is linked, and reopens via openFromLibrary', async () => {
    const spy = vi.spyOn(lib, 'saveEntry');
    useStore.getState().updateNote('a', { pitch: 70 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await useStore.getState().saveAs('Reopen me');
    const id = useStore.getState().libraryId!;
    useStore.getState().loadScore(makeScore('other'));
    expect(useStore.getState().libraryId).toBeNull();
    expect(await useStore.getState().openFromLibrary(id)).toBe(true);
    expect(useStore.getState().libraryName).toBe('Reopen me');
    expect(useStore.getState().score?.meta.title).toBe('auto');
  });
});

describe('project file', () => {
  it('round-trips a score through export and import', async () => {
    const score = makeScore();
    const text = exportProject(score, 'My tab');
    expect(JSON.parse(text)).toMatchObject({ format: 'tabscribe', version: 1 });
    expect(importProject(text).score).toEqual(score);

    const file = new File([text], 'My-tab.tabscribe.json', { type: 'application/json' });
    const back = await importFile(file);
    expect(back).toEqual(score);
  });

  it('rejects other JSON', async () => {
    const file = new File(['{"hello":1}'], 'x.json');
    await expect(importFile(file)).rejects.toThrow(/not a TabScribe/);
  });
});
