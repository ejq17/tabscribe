import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { guitarNotes } from '../store/ops';
import { activeAt, buildTimeline, tickAtPoint, type TimelineEntry } from './followAlong';
import { seekTo } from './playback';

interface Box { page: number; x: number; y: number; w: number; h: number }

/** Page images for OMR scores, with the selected note's source region highlighted. */
export default function SourcePane() {
  const score = useStore((s) => s.score);
  const selection = useStore((s) => s.selection);
  const pages = score?.meta.sourcePages;
  const [sizes, setSizes] = useState<Record<number, { w: number; h: number }>>({});
  const hlRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const timeline = useMemo(() => buildTimeline(score, sizes), [score, sizes]);
  const [active, setActive] = useState<TimelineEntry[]>([]);

  // Follow the playhead: coalesce ticks to animation frames, only re-render when the active set changes.
  useEffect(() => {
    let raf = 0;
    let lastKey = '';
    const update = () => {
      raf = 0;
      const { tick, isPlaying } = useStore.getState().playback;
      const next = isPlaying || tick > 0 ? activeAt(timeline, tick) : [];
      const key = next.map((e) => `${e.noteId}@${e.start}`).join('|');
      if (key !== lastKey) {
        lastKey = key;
        setActive(next);
      }
    };
    const unsub = useStore.subscribe((st, prev) => {
      if (st.playback.tick === prev.playback.tick && st.playback.isPlaying === prev.playback.isPlaying) return;
      if (!raf) raf = requestAnimationFrame(update);
    });
    update();
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [timeline]);

  // Keep the playing box in view (scrolls the pane across pages as needed).
  useEffect(() => {
    const el = playRef.current;
    const pane = paneRef.current;
    if (!el || !pane) return;
    const r = el.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
      const top = pane.scrollTop + (r.top - pr.top) - pane.clientHeight / 2 + r.height / 2;
      if (pane.scrollTo) pane.scrollTo({ top, behavior: 'smooth' });
      else pane.scrollTop = top;
    }
  }, [active]);

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

  const frac = (e: TimelineEntry) => ({ left: `${e.x * 100}%`, top: `${e.y * 100}%`, width: `${e.w * 100}%`, height: `${e.h * 100}%` });
  const onPageClick = (e: React.MouseEvent<HTMLDivElement>, page: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const t = tickAtPoint(timeline, page, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (t !== null) void seekTo(t).catch(() => {});
  };

  const rect = (b: Box) => {
    const s = sizes[b.page];
    // Boxes may be normalized (0..1) or in source pixels; handle both defensively.
    const norm = b.x <= 1 && b.y <= 1 && b.w <= 1 && b.h <= 1;
    const sw = norm ? 1 : (s?.w ?? 1);
    const sh = norm ? 1 : (s?.h ?? 1);
    return { left: `${(b.x / sw) * 100}%`, top: `${(b.y / sh) * 100}%`, width: `${(b.w / sw) * 100}%`, height: `${(b.h / sh) * 100}%` };
  };

  return (
    <aside className="source-pane" ref={paneRef} aria-label="Original sheet music">
      <h2 className="pane-title">Original</h2>
      {pages.map((src, i) => (
        <div className="source-page" key={i} onClick={(e) => onPageClick(e, i)}>
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
          {active.filter((a) => a.page === i).map((a, k) => (
            <div key={`${a.noteId}-${a.start}`} ref={k === 0 ? playRef : undefined} className={`src-box playing${a.noteId ? '' : ' measure'}`} style={frac(a)} />
          ))}
          {selBox && selBox.page === i && <div ref={hlRef} className="src-box sel" style={rect(selBox)} />}
        </div>
      ))}
    </aside>
  );
}
