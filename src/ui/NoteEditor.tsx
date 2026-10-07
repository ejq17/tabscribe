import { useEffect, useRef, useState } from 'react';
import { midiToName, nameToMidi, noteValueToTicks, ticksToNoteValue, type Note } from '../core';
import { useStore } from '../store';
import { fretOn, playableStrings } from '../store/ops';
import { useUi } from './uiStore';

const ARTICULATIONS = ['staccato', 'accent', 'hammer', 'pull', 'slide', 'bend', 'harmonic', 'palm-mute'];
const BASES: [number, string][] = [
  [1, 'Whole'],
  [2, 'Half'],
  [4, 'Quarter'],
  [8, 'Eighth'],
  [16, '16th'],
  [32, '32nd'],
];

interface Props {
  note: Note;
  anchor: { x: number; y: number } | null;
  containerWidth: number;
}

export default function NoteEditor({ note, anchor, containerWidth }: Props) {
  const guitar = useStore((s) => s.guitar);
  const ppq = useStore((s) => s.score?.ppq ?? 480);
  const updateNote = useStore((s) => s.updateNote);
  const deleteNotes = useStore((s) => s.deleteNotes);
  const moveNoteToString = useStore((s) => s.moveNoteToString);
  const close = () => useUi.getState().setEditorOpen(false);

  const [pitchText, setPitchText] = useState(midiToName(note.pitch));
  const [pitchBad, setPitchBad] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPitchText(midiToName(note.pitch));
    setPitchBad(false);
  }, [note.id, note.pitch]);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [note.id]);

  const nv = ticksToNoteValue(note.duration, ppq);
  const strings = playableStrings(note.pitch, guitar);
  const curString = note.tab?.string;
  const shownFret = note.tab ? note.tab.fret - guitar.capo : '';

  const commitPitch = () => {
    const m = nameToMidi(pitchText);
    if (m === null || m < 0 || m > 127) {
      setPitchBad(true);
      return;
    }
    setPitchBad(false);
    if (m !== note.pitch) updateNote(note.id, { pitch: m });
  };
  const setDuration = (base: number, dots: number, triplet: boolean) =>
    updateNote(note.id, { duration: noteValueToTicks({ base, dots, triplet }, ppq) });

  // Popover placement: below the note on wide screens; CSS turns it into a bottom sheet on phones.
  const style: React.CSSProperties = anchor
    ? { left: Math.max(8, Math.min(containerWidth - 308, anchor.x - 150)), top: anchor.y + 22 }
    : {};

  return (
    <div className="note-editor" style={style} ref={ref} role="dialog" aria-label="Edit note" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { (e.target as HTMLInputElement).blur(); }
    }}>
      <div className="ne-head">
        <strong>Edit note</strong>
        <button className="btn icon" aria-label="Close editor" onClick={close}>×</button>
      </div>
      <div className="ne-grid">
        <label>
          Pitch
          <input
            value={pitchText}
            aria-invalid={pitchBad}
            className={pitchBad ? 'bad' : ''}
            onChange={(e) => setPitchText(e.target.value)}
            onBlur={commitPitch}
            spellCheck={false}
          />
        </label>
        <label>
          String
          <select
            value={curString ?? ''}
            onChange={(e) => moveNoteToString(note.id, Number(e.target.value))}
            disabled={strings.length === 0}
          >
            {curString === undefined && <option value="">–</option>}
            {strings.map((s) => (
              <option key={s} value={s}>
                {s + 1} ({midiToName(guitar.tuning.pitches[s]).replace(/-?\d+$/, '')})
              </option>
            ))}
          </select>
        </label>
        <label>
          Fret
          <input
            type="number"
            min={0}
            max={guitar.maxFret - guitar.capo}
            value={shownFret}
            onChange={(e) => {
              const f = Number(e.target.value) + guitar.capo;
              if (curString !== undefined && Number.isFinite(f) && f >= guitar.capo && f <= guitar.maxFret) {
                updateNote(note.id, { tab: { string: curString, fret: f } });
              }
            }}
          />
        </label>
        <label>
          Duration
          <select value={nv.base} onChange={(e) => setDuration(Number(e.target.value), nv.dots, nv.triplet)}>
            {BASES.map(([b, name]) => (
              <option key={b} value={b}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ne-row">
        <label className="check">
          <input type="checkbox" checked={nv.dots > 0} onChange={(e) => setDuration(nv.base, e.target.checked ? 1 : 0, false)} /> Dotted
        </label>
        <label className="check">
          <input type="checkbox" checked={nv.triplet} onChange={(e) => setDuration(nv.base, 0, e.target.checked)} /> Triplet
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={!!note.tabLocked}
            onChange={(e) => updateNote(note.id, { tabLocked: e.target.checked })}
            disabled={!note.tab}
          />{' '}
          Lock fingering
        </label>
      </div>
      <div className="chips" role="group" aria-label="Articulations">
        {ARTICULATIONS.map((a) => {
          const on = note.articulations?.includes(a) ?? false;
          return (
            <button
              key={a}
              className={`chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                const cur = note.articulations ?? [];
                updateNote(note.id, { articulations: on ? cur.filter((x) => x !== a) : [...cur, a] });
              }}
            >
              {a}
            </button>
          );
        })}
      </div>
      {note.tab && fretOn(note.pitch, note.tab.string, guitar) === null && (
        <p className="ne-warn">This pitch is out of range for the current string.</p>
      )}
      <div className="ne-foot">
        <button className="btn danger" onClick={() => { deleteNotes([note.id]); close(); }}>
          Delete note
        </button>
        <button className="btn" onClick={close}>Done</button>
      </div>
    </div>
  );
}
