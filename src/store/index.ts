import { create } from 'zustand';
import {
  DEFAULT_GUITAR,
  guitarTrack,
  newNoteId,
  type GuitarConfig,
  type Note,
  type NoteId,
  type Score,
  TUNINGS,
} from '../core';
import { importFile } from '../importers';
import { assignTab } from '../tab';
import { detectChords, mergeOmrChords, type ChordEvent } from '../chords';
import { applyPatch, fretOn, guitarNotes, mapGuitarNotes, type NotePatch } from './ops';

export { fretOn, playableStrings, sortedNotes, guitarNotes } from './ops';
export type { NotePatch } from './ops';

export type ChordResolution = 'beat' | 'half' | 'measure';

export interface PlaybackState {
  isPlaying: boolean;
  tick: number;
  tempoScale: number;
  loop?: { from: number; to: number };
  metronome: boolean;
  volume: number;
}
export interface ViewState {
  showNotation: boolean;
  showChords: boolean;
  showDiagrams: boolean;
  showSource: boolean;
  mode: 'tab' | 'strum';
  zoom: number;
}
export interface StatusState {
  busy: boolean;
  stage?: string;
  fraction?: number;
  error?: string;
}
export interface SettingsState {
  chordResolution: ChordResolution;
  defaultClef: 'treble' | 'bass';
  /** Scanned sheet music is written for guitar (sounds an octave lower than printed). Applied to treble staves only, never inside a piano grand staff or a system with a bass-clef staff. */
  guitarOctave: boolean;
}

export interface AppState {
  score: Score | null;
  guitar: GuitarConfig;
  chords: ChordEvent[];
  selection: NoteId[];
  /** Insertion cursor in the tab view */
  cursor: { tick: number; string: number } | null;
  playback: PlaybackState;
  view: ViewState;
  settings: SettingsState;
  history: { past: Score[]; future: Score[] };
  status: StatusState;

  loadFile: (file: File) => Promise<void>;
  loadScore: (score: Score) => void;
  setGuitar: (partial: Partial<GuitarConfig>) => void;
  updateNote: (id: NoteId, patch: NotePatch) => void;
  /** Apply a patch (or per-note patch function) to many notes as ONE undo step. */
  updateNotes: (ids: NoteId[], patch: NotePatch | ((n: Note) => NotePatch)) => void;
  addNote: (n: { pitch: number; start: number; duration: number; voice?: number; tab?: { string: number; fret: number } }) => NoteId | null;
  deleteNotes: (ids: NoteId[]) => void;
  moveNoteToString: (id: NoteId, string: number) => boolean;
  transposeSelection: (semitones: number) => void;
  setSelection: (ids: NoteId[]) => void;
  setCursor: (c: { tick: number; string: number } | null) => void;
  undo: () => void;
  redo: () => void;
  reassignTab: () => void;
  clearLocks: () => void;
  setPlayback: (p: Partial<PlaybackState>) => void;
  setView: (v: Partial<ViewState>) => void;
  setSettings: (s: Partial<SettingsState>) => void;
  setStatus: (s: Partial<StatusState>) => void;
}

const HISTORY_CAP = 100;
const LS_KEY = 'tabscribe.prefs.v1';

interface Prefs {
  guitar?: GuitarConfig;
  view?: Partial<ViewState>;
  settings?: Partial<SettingsState>;
}

function readPrefs(): Prefs {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}
function writePrefs(p: Prefs) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const prefs = readPrefs();

const defaultView: ViewState = {
  showNotation: false,
  showChords: true,
  showDiagrams: false,
  showSource: false,
  mode: 'tab',
  zoom: 1,
};
const defaultSettings: SettingsState = { chordResolution: 'half', defaultClef: 'treble', guitarOctave: true };

function safeAssign(score: Score, guitar: GuitarConfig): Score {
  try {
    return assignTab(score, guitar);
  } catch (e) {
    console.warn('assignTab failed', e);
    return score;
  }
}
function safeChords(score: Score, resolution: ChordResolution): ChordEvent[] {
  try {
    return mergeOmrChords(score, detectChords(score, { resolution }));
  } catch (e) {
    console.warn('detectChords failed', e);
    return [];
  }
}

export const useStore = create<AppState>()((set, get) => {
  /** Recompute tab + chords for a freshly mutated score; optionally push history. */
  const commit = (next: Score, pushHistory = true, extra: Partial<AppState> = {}) => {
    const { guitar, settings, history, score } = get();
    const assigned = safeAssign(next, guitar);
    const chords = safeChords(assigned, settings.chordResolution);
    const h = pushHistory && score ? { past: [...history.past, score].slice(-HISTORY_CAP), future: [] } : history;
    set({ score: assigned, chords, history: h, ...extra });
  };

  return {
    score: null,
    guitar: prefs.guitar?.tuning?.pitches?.length ? { ...DEFAULT_GUITAR, ...prefs.guitar } : DEFAULT_GUITAR,
    chords: [],
    selection: [],
    cursor: null,
    playback: { isPlaying: false, tick: 0, tempoScale: 1, metronome: false, volume: 0.8 },
    view: { ...defaultView, ...prefs.view },
    settings: { ...defaultSettings, ...prefs.settings },
    history: { past: [], future: [] },
    status: { busy: false },

    async loadFile(file) {
      set({ status: { busy: true, stage: 'Reading file…', fraction: 0 } });
      try {
        const opts = {
          onProgress: (p: { stage: string; fraction: number }) =>
            set({ status: { busy: true, stage: p.stage, fraction: p.fraction } }),
          defaultClef: get().settings.defaultClef,
          instrument: (get().settings.guitarOctave ? 'guitar' : 'concert') as 'guitar' | 'concert',
        };
        const score = await importFile(file, opts);
        if (!score.meta.title) score.meta.title = file.name.replace(/\.[^.]+$/, '');
        get().loadScore(score);
        set({ status: { busy: false } });
      } catch (e) {
        set({ status: { busy: false, error: e instanceof Error ? e.message : String(e) } });
      }
    },

    loadScore(score) {
      const { settings } = get();
      let guitar = get().guitar;
      // Guitar Pro / MusicXML files carry their own tuning and capo; adopt them so the file's fingering is valid.
      const metaTuning = score.meta.tuning as number[] | undefined;
      if (Array.isArray(metaTuning) && metaTuning.length >= 4 && metaTuning.every((p) => Number.isFinite(p))) {
        const known = TUNINGS.find((t) => t.pitches.length === metaTuning.length && t.pitches.every((p, i) => p === metaTuning[i]));
        const capo = typeof score.meta.capo === 'number' ? score.meta.capo : 0;
        guitar = { ...guitar, tuning: known ?? { name: 'From file', pitches: [...metaTuning] }, capo };
        writePrefs({ guitar, view: get().view, settings });
      }
      const assigned = safeAssign(score, guitar);
      set({
        guitar,
        score: assigned,
        chords: safeChords(assigned, settings.chordResolution),
        selection: [],
        cursor: null,
        history: { past: [], future: [] },
        playback: { ...get().playback, isPlaying: false, tick: 0, loop: undefined },
        view: { ...get().view, showSource: !!assigned.meta.sourcePages?.length },
      });
    },

    setGuitar(partial) {
      const guitar = { ...get().guitar, ...partial };
      writePrefs({ guitar, view: get().view, settings: get().settings });
      const { score, settings } = get();
      if (!score) return set({ guitar });
      // Locked notes whose fingering no longer sounds the right pitch become unlocked.
      const fixed = mapGuitarNotes(score, (n) => {
        if (n.tabLocked && n.tab && guitar.tuning.pitches[n.tab.string] + n.tab.fret !== n.pitch) {
          const { tab: _t, ...rest } = n;
          return { ...rest, tabLocked: false };
        }
        return n;
      });
      const assigned = safeAssign(fixed, guitar);
      set({ guitar, score: assigned, chords: safeChords(assigned, settings.chordResolution) });
    },

    updateNote(id, patch) {
      const { score, guitar } = get();
      if (!score) return;
      commit(mapGuitarNotes(score, (n) => (n.id === id ? applyPatch(n, patch, guitar) : n)));
    },

    updateNotes(ids, patch) {
      const { score, guitar } = get();
      if (!score || ids.length === 0) return;
      const sel = new Set(ids);
      commit(
        mapGuitarNotes(score, (n) =>
          sel.has(n.id) ? applyPatch(n, typeof patch === 'function' ? patch(n) : patch, guitar) : n,
        ),
      );
    },

    addNote({ pitch, start, duration, voice = 0, tab }) {
      const { score } = get();
      if (!score) return null;
      const note: Note = { id: newNoteId(), pitch, start, duration, velocity: 90, voice };
      if (tab) {
        note.tab = tab;
        note.tabLocked = true;
      }
      let next: Score;
      const t = guitarTrack(score);
      if (t) next = { ...score, tracks: score.tracks.map((x) => (x === t ? { ...x, notes: [...x.notes, note] } : x)) };
      else
        next = {
          ...score,
          tracks: [...score.tracks, { id: 'guitar', name: 'Guitar', program: 25, notes: [note], isGuitarTarget: true }],
        };
      commit(next, true, { selection: [note.id] });
      return note.id;
    },

    deleteNotes(ids) {
      const { score, selection } = get();
      if (!score || ids.length === 0) return;
      const set_ = new Set(ids);
      const t = guitarTrack(score);
      if (!t) return;
      const next: Score = {
        ...score,
        tracks: score.tracks.map((x) => (x === t ? { ...x, notes: x.notes.filter((n) => !set_.has(n.id)) } : x)),
      };
      commit(next, true, { selection: selection.filter((i) => !set_.has(i)) });
    },

    moveNoteToString(id, string) {
      const { score, guitar } = get();
      if (!score) return false;
      const note = guitarNotes(score).find((n) => n.id === id);
      if (!note) return false;
      const fret = fretOn(note.pitch, string, guitar);
      if (fret === null) return false;
      commit(mapGuitarNotes(score, (n) => (n.id === id ? { ...n, tab: { string, fret }, tabLocked: true } : n)));
      return true;
    },

    transposeSelection(semitones) {
      const { score, selection, guitar } = get();
      if (!score || selection.length === 0 || semitones === 0) return;
      const sel = new Set(selection);
      commit(
        mapGuitarNotes(score, (n) => {
          if (!sel.has(n.id)) return n;
          const pitch = Math.max(0, Math.min(127, n.pitch + semitones));
          return applyPatch(n, { pitch }, guitar);
        }),
      );
    },

    setSelection(ids) {
      set({ selection: ids });
    },
    setCursor(cursor) {
      set({ cursor });
    },

    undo() {
      const { history, score, settings, selection } = get();
      if (!score || history.past.length === 0) return;
      const prev = history.past[history.past.length - 1];
      const ids = new Set(guitarNotes(prev).map((n) => n.id));
      set({
        score: prev,
        chords: safeChords(prev, settings.chordResolution),
        history: { past: history.past.slice(0, -1), future: [score, ...history.future].slice(0, HISTORY_CAP) },
        selection: selection.filter((i) => ids.has(i)),
      });
    },

    redo() {
      const { history, score, settings, selection } = get();
      if (!score || history.future.length === 0) return;
      const [next, ...rest] = history.future;
      const ids = new Set(guitarNotes(next).map((n) => n.id));
      set({
        score: next,
        chords: safeChords(next, settings.chordResolution),
        history: { past: [...history.past, score].slice(-HISTORY_CAP), future: rest },
        selection: selection.filter((i) => ids.has(i)),
      });
    },

    reassignTab() {
      const { score } = get();
      if (score) commit(score);
    },

    clearLocks() {
      const { score } = get();
      if (!score) return;
      commit(mapGuitarNotes(score, (n) => (n.tabLocked ? { ...n, tabLocked: false } : n)));
    },

    setPlayback(p) {
      set({ playback: { ...get().playback, ...p } });
    },

    setView(v) {
      const view = { ...get().view, ...v };
      set({ view });
      writePrefs({ guitar: get().guitar, view, settings: get().settings });
    },

    setSettings(s) {
      const settings = { ...get().settings, ...s };
      set({ settings });
      writePrefs({ guitar: get().guitar, view: get().view, settings });
      const { score } = get();
      if (score && s.chordResolution) set({ chords: safeChords(score, settings.chordResolution) });
    },

    setStatus(s) {
      set({ status: { ...get().status, ...s } });
    },
  };
});
