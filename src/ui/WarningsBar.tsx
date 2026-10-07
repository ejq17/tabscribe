import { useState } from 'react';
import { useStore } from '../store';

export default function WarningsBar() {
  const warnings = useStore((s) => s.score?.meta.warnings);
  const [open, setOpen] = useState(false);
  if (!warnings || warnings.length === 0) return null;
  return (
    <section className="warnings" aria-label="Import warnings">
      <button className="warn-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden>⚠</span> {warnings.length} import {warnings.length === 1 ? 'warning' : 'warnings'}
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
