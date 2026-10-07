import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { guitarNotes } from '../store/ops';

interface Box { page: number; x: number; y: number; w: number; h: number }

/** Page images for OMR scores, with the selected note's source region highlighted. */
export default function SourcePane() {
  const score = useStore((s) => s.score);
  const selection = useStore((s) => s.selection);
  const pages = score?.meta.sourcePages;
  const [sizes, setSizes] = useState<Record<number, { w: number; h: number }>>({});
  const hlRef = useRef<HTMLDivElement>(null);

  const raw = (score?.meta as { omrBoxes?: Record<string, Box | Box[]> } | undefined)?.omrBoxes;
  const first = (v: Box | Box[] | undefined): Box | undefined => (Array.isArray(v) ? v[0] : v);
  const boxes = raw;
  const selId = selection[selection.length - 1];
  const selBox = selId ? first(boxes?.[selId]) : undefined;

  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selId, selBox]);

  if (!pages?.length) return null;

  const low: Box[] = [];
  if (boxes && score)
    for (const n of guitarNotes(score)) {
      const b = first(boxes[n.id]);
      if (b && n.confidence !== undefined && n.confidence < 0.7 && n.id !== selId) low.push(b);
    }

  const rect = (b: Box) => {
    const s = sizes[b.page];
    // Boxes may be normalized (0..1) or in source pixels; handle both defensively.
    const norm = b.x <= 1 && b.y <= 1 && b.w <= 1 && b.h <= 1;
    const sw = norm ? 1 : (s?.w ?? 1);
    const sh = norm ? 1 : (s?.h ?? 1);
    return { left: `${(b.x / sw) * 100}%`, top: `${(b.y / sh) * 100}%`, width: `${(b.w / sw) * 100}%`, height: `${(b.h / sh) * 100}%` };
  };

  return (
    <aside className="source-pane" aria-label="Original sheet music">
      <h2 className="pane-title">Original</h2>
      {pages.map((src, i) => (
        <div className="source-page" key={i}>
          <img
            src={src}
            alt={`Source page ${i + 1}`}
            onLoad={(e) => {
              const t = e.currentTarget;
              setSizes((p) => ({ ...p, [i]: { w: t.naturalWidth, h: t.naturalHeight } }));
            }}
          />
          {low.filter((b) => b.page === i).map((b, k) => (
            <div key={k} className="src-box low" style={rect(b)} />
          ))}
          {selBox && selBox.page === i && <div ref={hlRef} className="src-box sel" style={rect(selBox)} />}
        </div>
      ))}
    </aside>
  );
}
