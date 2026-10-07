import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_EXTENSIONS } from '../importers';
import { useStore } from '../store';

export function useOpenFile() {
  const loadFile = useStore((s) => s.loadFile);
  return (file: File | undefined | null) => {
    if (file) void loadFile(file);
  };
}

export const ACCEPT = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');

/** Full-window drag and drop overlay. Renders nothing unless dragging. */
export function DropOverlay() {
  const open = useOpenFile();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      open(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [open]);
  if (!dragging) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-card">Drop a file to turn it into tab</div>
    </div>
  );
}

export function ProgressCard() {
  const status = useStore((s) => s.status);
  if (!status.busy) return null;
  const pct = Math.round((status.fraction ?? 0) * 100);
  return (
    <div className="progress-card" role="status" aria-live="polite">
      <p>{status.stage || 'Working…'}</p>
      <div className="bar" aria-hidden>
        <div className="bar-fill" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <small>{pct}%</small>
    </div>
  );
}

export function ErrorNote() {
  const error = useStore((s) => s.status.error);
  const setStatus = useStore((s) => s.setStatus);
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <strong>Couldn’t open that file.</strong> {error}
      <button className="btn icon" aria-label="Dismiss error" onClick={() => setStatus({ error: undefined })}>×</button>
    </div>
  );
}

export function EmptyState() {
  const open = useOpenFile();
  const busy = useStore((s) => s.status.busy);
  const inputRef = useRef<HTMLInputElement>(null);
  if (busy) return null;
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden>
        <svg viewBox="0 0 120 60" width="180">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <line key={i} x1="4" x2="116" y1={8 + i * 9} y2={8 + i * 9} />
          ))}
          <text x="22" y="32">3</text>
          <text x="46" y="14">0</text>
          <text x="70" y="41">2</text>
          <text x="94" y="23">5</text>
        </svg>
      </div>
      <h1>Turn music into guitar tab</h1>
      <p className="lede">Drop a file anywhere on this page, or choose one. Everything runs in your browser and works offline once loaded.</p>
      <button className="btn primary big" onClick={() => inputRef.current?.click()}>
        Choose a file
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
      <dl className="formats">
        <div><dt>Sheet music</dt><dd>PDF, PNG, JPG, WebP (scanned with built-in recognition)</dd></div>
        <div><dt>Score files</dt><dd>MIDI, MusicXML (.xml, .musicxml, .mxl), ABC, Guitar Pro (.gp3 .gp4 .gp5 .gpx .gp)</dd></div>
        <div><dt>Audio</dt><dd>MP3, WAV, M4A, OGG (single-note melodies work best)</dd></div>
      </dl>
      <p className="hint">Edit with the keyboard: arrows move, digits set frets, S switches string, Space plays.</p>
    </div>
  );
}
