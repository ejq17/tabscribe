import { useEffect, useState } from 'react';
import { TUNINGS, midiToName, nameToMidi } from '../core';
import { useStore } from '../store';
import { useUi } from './uiStore';

function CustomTuning() {
  const guitar = useStore((s) => s.guitar);
  const setGuitar = useStore((s) => s.setGuitar);
  const [texts, setTexts] = useState(guitar.tuning.pitches.map((p) => midiToName(p)));
  useEffect(() => setTexts(guitar.tuning.pitches.map((p) => midiToName(p))), [guitar.tuning]);
  const parsed = texts.map((t) => nameToMidi(t));
  const bad = parsed.map((p) => p === null || p < 0 || p > 127);
  const anyBad = bad.some(Boolean);
  return (
    <fieldset className="custom-tuning">
      <legend>Custom tuning (high string first)</legend>
      <div className="ct-row">
        {texts.map((t, i) => (
          <input
            key={i}
            value={t}
            className={bad[i] ? 'bad' : ''}
            aria-label={`String ${i + 1} note`}
            aria-invalid={bad[i]}
            spellCheck={false}
            onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))}
          />
        ))}
      </div>
      <button
        className="btn"
        disabled={anyBad}
        onClick={() => setGuitar({ tuning: { name: 'Custom', pitches: parsed as number[] } })}
      >
        Apply custom tuning
      </button>
      {anyBad && <p className="field-err">Use note names like E4, Bb3, F#2.</p>}
    </fieldset>
  );
}

export default function Settings() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const guitar = useStore((s) => s.guitar);
  const setGuitar = useStore((s) => s.setGuitar);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const reassignTab = useStore((s) => s.reassignTab);
  const clearLocks = useStore((s) => s.clearLocks);
  const hasScore = useStore((s) => !!s.score);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const known = TUNINGS.findIndex((t) => t.pitches.join() === guitar.tuning.pitches.join());

  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={() => setOpen(false)} />
      <aside className="drawer" role="dialog" aria-label="Settings" aria-modal="true">
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="btn icon" aria-label="Close settings" onClick={() => setOpen(false)}>×</button>
        </div>

        <section>
          <h3>Guitar</h3>
          <label className="field">
            Tuning
            <select
              value={known >= 0 ? String(known) : 'custom'}
              onChange={(e) => {
                if (e.target.value !== 'custom') setGuitar({ tuning: TUNINGS[Number(e.target.value)] });
              }}
            >
              {TUNINGS.map((t, i) => (
                <option key={t.name} value={i}>
                  {t.name}
                </option>
              ))}
              {known < 0 && <option value="custom">{guitar.tuning.name || 'Custom'}</option>}
            </select>
          </label>
          <CustomTuning />
          <div className="field-row">
            <label className="field">
              Capo
              <select value={guitar.capo} onChange={(e) => setGuitar({ capo: Number(e.target.value) })}>
                {Array.from({ length: 13 }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? 'None' : `Fret ${i}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Max fret
              <input
                type="number"
                min={12}
                max={30}
                value={guitar.maxFret}
                onChange={(e) => {
                  const v = Math.max(12, Math.min(30, Number(e.target.value) || 22));
                  setGuitar({ maxFret: v });
                }}
              />
            </label>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={!hasScore} onClick={reassignTab}>
              Re-finger tab
            </button>
            <button className="btn" disabled={!hasScore} onClick={clearLocks}>
              Clear all locks
            </button>
          </div>
        </section>

        <section>
          <h3>Analysis</h3>
          <label className="field">
            Chord resolution
            <select value={settings.chordResolution} onChange={(e) => setSettings({ chordResolution: e.target.value as 'beat' | 'half' | 'measure' })}>
              <option value="beat">Every beat</option>
              <option value="half">Half measure</option>
              <option value="measure">Whole measure</option>
            </select>
          </label>
          <label className="field">
            Default clef for scanned sheet music
            <select value={settings.defaultClef} onChange={(e) => setSettings({ defaultClef: e.target.value as 'treble' | 'bass' })}>
              <option value="treble">Treble</option>
              <option value="bass">Bass</option>
            </select>
          </label>
        </section>

        <section>
          <h3>Display</h3>
          {(
            [
              ['showChords', 'Chord names'],
              ['showDiagrams', 'Chord diagrams'],
              ['showNotation', 'Standard notation'],
            ] as const
          ).map(([k, label]) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={view[k]} onChange={(e) => setView({ [k]: e.target.checked })} /> {label}
            </label>
          ))}
          <label className="field">
            Zoom {Math.round(view.zoom * 100)}%
            <input type="range" min={60} max={160} step={10} value={Math.round(view.zoom * 100)} onChange={(e) => setView({ zoom: Number(e.target.value) / 100 })} />
          </label>
        </section>
      </aside>
    </div>
  );
}
