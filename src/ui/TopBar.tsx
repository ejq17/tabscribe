import { useRef } from 'react';
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
      {score?.meta.title && <span className="doc-title" title={score.meta.title}>{score.meta.title}</span>}
      <div className="tb-group">
        <ExportMenu />
        <button className="btn" onClick={() => useUi.getState().setSettingsOpen(true)} aria-label="Settings">⚙ Settings</button>
      </div>
    </header>
  );
}
