import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { guitarNotes } from '../store/ops';
import { LINE_GAP, layoutTab, measureClickTick, type MeasureLayout, type SystemLayout } from './tabLayout';
import TabSystems, { notePos } from './TabSystems';
import Playhead from './Playhead';
import NoteEditor from './NoteEditor';
import { useWidth } from './useWidth';
import { useUi } from './uiStore';
import { seekTo } from './playback';

export default function TabView() {
  const score = useStore((s) => s.score);
  const guitar = useStore((s) => s.guitar);
  const chords = useStore((s) => s.chords);
  const selection = useStore((s) => s.selection);
  const cursor = useStore((s) => s.cursor);
  const view = useStore((s) => s.view);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const editorOpen = useUi((s) => s.editorOpen);

  const layoutWidth = Math.max(280, width / view.zoom);
  const layout = useMemo(
    () => (score ? layoutTab(score, guitar, chords, { width: layoutWidth, showChords: view.showChords, showDiagrams: view.showDiagrams }) : null),
    [score, guitar, chords, layoutWidth, view.showChords, view.showDiagrams],
  );
  const selSet = useMemo(() => new Set(selection), [selection]);

  const onNoteClick = useCallback((id: string, additive: boolean) => {
    const st = useStore.getState();
    const n = st.score ? guitarNotes(st.score).find((x) => x.id === id) : undefined;
    if (n) void seekTo(n.start).catch(() => {});
    if (additive) st.setSelection(st.selection.includes(id) ? st.selection.filter((x) => x !== id) : [...st.selection, id]);
    else st.setSelection([id]);
    st.setCursor(null);
  }, []);

  const onStaffPointer = useCallback(
    (e: React.MouseEvent<SVGRectElement>, sys: SystemLayout, m: MeasureLayout, double: boolean) => {
      const svg = e.currentTarget.ownerSVGElement;
      const st = useStore.getState();
      if (!svg || !st.score) return;
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const k = vb.width / r.width;
      const x = (e.clientX - r.left) * k;
      const y = (e.clientY - r.top) * k;
      const nStr = st.guitar.tuning.pitches.length;
      const string = Math.max(0, Math.min(nStr - 1, Math.round((y - sys.staffTop) / LINE_GAP)));
      const tick = measureClickTick(m, x, st.score.ppq);
      if (!double) void seekTo(tick).catch(() => {});
      st.setCursor({ tick, string });
      if (!e.shiftKey) st.setSelection([]);
      if (double) {
        const fret = st.guitar.capo;
        const pitch = st.guitar.tuning.pitches[string] + fret;
        st.addNote({ pitch, start: tick, duration: st.score.ppq, voice: 0, tab: { string, fret } });
        st.setCursor(null);
      }
    },
    [],
  );

  // keep the selected note visible
  const primary = selection[selection.length - 1];
  useEffect(() => {
    if (!primary || !layout || !score) return;
    const n = guitarNotes(score).find((x) => x.id === primary);
    const sc = wrapRef.current?.closest('.scroll-area') as HTMLElement | null;
    const svg = wrapRef.current?.querySelector('svg.tab-svg');
    if (!n || !sc || !svg) return;
    const p = notePos(layout, n);
    if (!p) return;
    const rect = svg.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    const y = rect.top - scRect.top + p.y * (rect.width / layout.width);
    if (y < 40 || y > sc.clientHeight - 40) sc.scrollBy?.({ top: y - sc.clientHeight / 2, behavior: 'smooth' });
  }, [primary]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!score || !layout) return null;
  const selNote = primary ? guitarNotes(score).find((n) => n.id === primary) : undefined;
  const pos = selNote ? notePos(layout, selNote) : null;

  return (
    <div className="tabview print-area" ref={wrapRef}>
      <svg
        className="tab-svg"
        width={layout.width * view.zoom}
        height={layout.height * view.zoom}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="application"
        aria-label="Guitar tablature editor"
      >
        <TabSystems
          layout={layout}
          guitar={guitar}
          chords={chords}
          showChords={view.showChords}
          showDiagrams={view.showDiagrams}
          selection={selSet}
          cursor={cursor}
          onNoteClick={onNoteClick}
          onStaffPointer={onStaffPointer}
        />
        <Playhead layout={layout} scroller={wrapRef} />
      </svg>
      {editorOpen && selNote && (
        <NoteEditor note={selNote} anchor={pos ? { x: pos.x * view.zoom, y: pos.y * view.zoom } : null} containerWidth={width} />
      )}
    </div>
  );
}
