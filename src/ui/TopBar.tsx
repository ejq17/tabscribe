import { useRef } from 'react';
import { keyName, keySignatureAt, tempoAt, timeSignatureAt, type KeySignature } from '../core';
import { useStore } from '../store';
import ExportMenu from './ExportMenu';
import { ACCEPT, useOpenFile } from './FileDrop';
import { useUi } from './uiStore';

function Toggle({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button className={`btn toggle${on ? ' on' : ''}`} onClick={onClick} aria-pressed={on} aria-label={label}>
      {children}
    </button>
  );
}

function keyLabel(score: { keySignatures: KeySignature[] }, tick: number): string {
  if (!score.keySignatures.length) return '–';
  const k = keySignatureAt(score as never, tick);
  const rel: KeySignature = { ...k, mode: k.mode === 'minor' ? 'major' : 'minor' };
  return `${keyName(k)} / ${keyName(rel)}`;
}

/** Key, time signature and tempo at the playhead. */
function KeyInfo() {
  const info = useStore((s) => {
    if (!s.score) return '';
    const t = s.playback.tick;
    const ts = timeSignatureAt(s.score, t);
    return `${keyLabel(s.score, t)}|${ts.numerator}/${ts.denominator}|${Math.round(tempoAt(s.score, t).bpm)}`;
  });
  if (!info) return null;
  const [key, ts, bpm] = info.split('|');
  return (
    <span className="key-info" aria-label="Key, time signature and tempo">
      <span className="key-name" title="Key at the playhead">Key: {key}</span>
      <span className="muted">{ts} · ♩={bpm}</span>
    </span>
  );
}

function SaveIndicator() {
  const st = useStore((s) => s.saveStatus);
  const linked = useStore((s) => !!s.libraryId);
  if (!linked) return null;
  const text = st === 'saving' ? 'Saving…' : st === 'error' ? 'Save failed' : 'Saved';
  return (
    <span className={`save-ind ${st}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

export default function TopBar() {
  const open = useOpenFile();
  const inputRef = useRef<HTMLInputElement>(null);
  const score = useStore((s) => s.score);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const canUndo = useStore((s) => s.history.past.length > 0);
  const canRedo = useStore((s) => s.history.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const libraryName = useStore((s) => s.libraryName);
  const busy = useStore((s) => s.status.busy);
  const hasSource = !!score?.meta.sourcePages?.length;

  return (
    <header className="topbar">
      <div className="brand" aria-label="TabScribe">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
          <rect width="32" height="32" rx="7" className="brand-bg" />
          <path d="M9 9h14M16 9v15" className="brand-t" />
        </svg>
        <span>TabScribe</span>
      </div>
      <div className="tb-group">
        <button className="btn primary" onClick={() => inputRef.current?.click()} disabled={busy} aria-label="Open file">
          Open…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            open(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button className="btn" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)">↶</button>
        <button className="btn" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)">↷</button>
      </div>
      {score && (
        <>
          <div className="tb-group seg" role="group" aria-label="View mode">
            <Toggle on={view.mode === 'tab'} onClick={() => setView({ mode: 'tab' })} label="Tab view">Tab</Toggle>
            <Toggle on={view.mode === 'strum'} onClick={() => setView({ mode: 'strum' })} label="Strum chart view">Strum</Toggle>
          </div>
          <div className="tb-group">
            <Toggle on={view.showChords} onClick={() => setView({ showChords: !view.showChords })} label="Show chord names">Chords</Toggle>
            <Toggle on={view.showDiagrams} onClick={() => setView({ showDiagrams: !view.showDiagrams })} label="Show chord diagrams">Diagrams</Toggle>
            <Toggle on={view.showNotation} onClick={() => setView({ showNotation: !view.showNotation })} label="Show standard notation">Notation</Toggle>
            {hasSource && <Toggle on={view.showSource} onClick={() => setView({ showSource: !view.showSource })} label="Show original page">Source</Toggle>}
          </div>
        </>
      )}
      <div className="tb-spacer" />
      {score && <KeyInfo />}
      {score && (libraryName || score.meta.title) && <span className="doc-title" title={libraryName || score.meta.title}>{libraryName || score.meta.title}</span>}
      <SaveIndicator />
      <div className="tb-group">
        <button className="btn" onClick={() => useUi.getState().setLibraryOpen(true)} aria-label="Library">Library</button>
        <ExportMenu />
        <button className="btn" onClick={() => useUi.getState().setSettingsOpen(true)} aria-label="Settings">⚙ Settings</button>
      </div>
    </header>
  );
}
