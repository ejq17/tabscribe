import { useEffect, useRef, useState } from 'react';
import { exportMidi, exportMusicXml, downloadBlob } from '../export';
import { toAsciiTab } from '../tab';
import { useStore } from '../store';

function safeName(title?: string): string {
  return (title || 'tabscribe').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'tabscribe';
}

export default function ExportMenu() {
  const score = useStore((s) => s.score);
  const guitar = useStore((s) => s.guitar);
  const chords = useStore((s) => s.chords);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    if (!score) return;
    try {
      setErr(null);
      fn();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const base = safeName(score?.meta.title);

  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} disabled={!score} aria-haspopup="menu" aria-expanded={open} aria-label="Export menu">
        Export ▾
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button role="menuitem" onClick={() => run(() => downloadBlob(exportMidi(score!) as BlobPart, `${base}.mid`, 'audio/midi'))}>
            MIDI (.mid)
          </button>
          <button role="menuitem" onClick={() => run(() => downloadBlob(exportMusicXml(score!, guitar), `${base}.musicxml`, 'application/vnd.recordare.musicxml+xml'))}>
            MusicXML (.musicxml)
          </button>
          <button role="menuitem" onClick={() => run(() => downloadBlob(toAsciiTab(score!, guitar, { chords }), `${base}.txt`, 'text/plain'))}>
            ASCII tab (.txt)
          </button>
          <button role="menuitem" onClick={() => run(() => window.print())}>
            Print / PDF…
          </button>
          {err && <p className="menu-err">{err}</p>}
        </div>
      )}
    </div>
  );
}
