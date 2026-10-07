import { memo, useMemo } from 'react';
import { midiToName, ticksToNoteValue, type GuitarConfig, type Note } from '../core';
import { chordDiagram, type ChordEvent } from '../chords';
import ChordDiagramSvg from './ChordDiagramSvg';
import { LINE_GAP, findSystem, tickToX, type MeasureLayout, type SystemLayout, type TabLayout, LABEL_W, SIDE_PAD, TS_W } from './tabLayout';

export interface TabSystemsProps {
  layout: TabLayout;
  guitar: GuitarConfig;
  chords: ChordEvent[];
  showChords: boolean;
  showDiagrams: boolean;
  selection: Set<string>;
  cursor: { tick: number; string: number } | null;
  onNoteClick: (id: string, additive: boolean) => void;
  onStaffPointer: (e: React.MouseEvent<SVGRectElement>, sys: SystemLayout, m: MeasureLayout, double: boolean) => void;
}

export function notePos(layout: TabLayout, n: Note): { x: number; y: number; sys: SystemLayout } | null {
  const f = findSystem(layout, n.start);
  if (!f || !n.tab) return null;
  return { x: tickToX(f.m, n.start), y: f.sys.staffTop + n.tab.string * LINE_GAP, sys: f.sys };
}

function stringLabel(p: number): string {
  return midiToName(p).replace(/-?\d+$/, '');
}

function MeasureNotes({ m, sys, props }: { m: MeasureLayout; sys: SystemLayout; props: TabSystemsProps }) {
  const { layout, guitar, selection, onNoteClick } = props;
  const ppq = layout.ppq;
  const n = layout.nStrings;
  const bottom = sys.staffTop + (n - 1) * LINE_GAP;
  const stemTop = bottom + 9;
  const stemEnd = stemTop + 22;
  const els: React.ReactNode[] = [];

  // Notes
  for (const note of m.notes) {
    const x = tickToX(m, note.start);
    if (!note.tab) {
      continue;
    }
    const y = sys.staffTop + note.tab.string * LINE_GAP;
    const label = String(Math.max(0, note.tab.fret - guitar.capo));
    const sel = selection.has(note.id);
    const low = note.confidence !== undefined && note.confidence < 0.7;
    const w = label.length * 7.5 + 6;
    els.push(
      <g
        key={note.id}
        className={`tab-note${sel ? ' sel' : ''}${low ? ' low' : ''}${note.tabLocked ? ' locked' : ''}`}
        data-note-id={note.id}
        onClick={(e) => {
          e.stopPropagation();
          onNoteClick(note.id, e.shiftKey || e.metaKey || e.ctrlKey);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <rect x={x - w / 2} y={y - 9} width={w} height={18} rx={4} className="tn-bg" />
        <text x={x} y={y + 4.5} textAnchor="middle" className="tn-text">
          {label}
        </text>
        {note.tabLocked && <line x1={x - w / 2 + 2} x2={x + w / 2 - 2} y1={y + 9.5} y2={y + 9.5} className="tn-lock" />}
        {note.articulations?.length ? (
          <text x={x} y={y - 11} textAnchor="middle" className="tn-art">
            {articulationGlyph(note.articulations)}
          </text>
        ) : null}
      </g>,
    );
  }

  // Ties
  for (const note of m.notes) {
    if (!note.tiedFromPrevious || !note.tab) continue;
    const x2 = tickToX(m, note.start);
    const y = sys.staffTop + note.tab.string * LINE_GAP;
    let x1 = x2 - 26;
    const prev = sys.measures
      .flatMap((mm) => mm.notes.map((nn) => ({ nn, mm })))
      .find(({ nn }) => nn.pitch === note.pitch && nn.start + nn.duration === note.start && nn.id !== note.id);
    if (prev) x1 = tickToX(prev.mm, prev.nn.start) + 8;
    x1 = Math.max(x1, SIDE_PAD + LABEL_W);
    els.push(<path key={`tie-${note.id}`} d={`M ${x1} ${y - 11} Q ${(x1 + x2) / 2} ${y - 20} ${x2 - 6} ${y - 11}`} className="tab-tie" />);
  }

  // Stems & beams
  const groups = new Map<number, Note[]>();
  for (const note of m.notes) {
    const g = groups.get(note.start);
    if (g) g.push(note);
    else groups.set(note.start, [note]);
  }
  const stems = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, ns]) => {
      const dur = Math.min(...ns.map((q) => q.duration));
      const v = ticksToNoteValue(dur, ppq);
      return { tick, x: tickToX(m, tick), v, beat: Math.floor((tick - m.measure.startTick) / ppq) };
    });
  let i = 0;
  while (i < stems.length) {
    const s = stems[i];
    if (s.v.base >= 8) {
      let j = i;
      while (j + 1 < stems.length && stems[j + 1].v.base >= 8 && stems[j + 1].beat === s.beat) j++;
      const run = stems.slice(i, j + 1);
      for (const r of run) els.push(<line key={`st${r.tick}`} x1={r.x} x2={r.x} y1={stemTop} y2={stemEnd} className="tab-stem" />);
      if (run.length >= 2) {
        els.push(<line key={`b1-${s.tick}`} x1={run[0].x} x2={run[run.length - 1].x} y1={stemEnd} y2={stemEnd} className="tab-beam" />);
        for (let k = 0; k < run.length - 1; k++) {
          if (run[k].v.base >= 16 && run[k + 1].v.base >= 16)
            els.push(<line key={`b2-${run[k].tick}`} x1={run[k].x} x2={run[k + 1].x} y1={stemEnd - 4} y2={stemEnd - 4} className="tab-beam" />);
          else if (run[k].v.base >= 16)
            els.push(<line key={`b2l-${run[k].tick}`} x1={run[k].x} x2={run[k].x + 7} y1={stemEnd - 4} y2={stemEnd - 4} className="tab-beam" />);
          else if (run[k + 1].v.base >= 16)
            els.push(<line key={`b2r-${run[k].tick}`} x1={run[k + 1].x - 7} x2={run[k + 1].x} y1={stemEnd - 4} y2={stemEnd - 4} className="tab-beam" />);
        }
      } else {
        const r = run[0];
        const flags = r.v.base >= 16 ? 2 : 1;
        for (let f = 0; f < flags; f++)
          els.push(<path key={`fl${r.tick}-${f}`} d={`M ${r.x} ${stemEnd - f * 4} q 7 3 5 11`} className="tab-flag" />);
      }
      for (const r of run) {
        if (r.v.dots > 0) els.push(<circle key={`d${r.tick}`} cx={r.x + 5} cy={stemEnd - 2} r={1.6} className="tab-dot" />);
        if (r.v.triplet) els.push(<text key={`t${r.tick}`} x={r.x} y={stemEnd + 11} textAnchor="middle" className="tab-trip">3</text>);
      }
      i = j + 1;
    } else {
      if (s.v.base === 1) {
        els.push(<circle key={`w${s.tick}`} cx={s.x} cy={stemTop + 6} r={4} className="tab-whole" />);
      } else {
        els.push(<line key={`st${s.tick}`} x1={s.x} x2={s.x} y1={stemTop} y2={stemEnd} className="tab-stem" />);
        if (s.v.base === 2) els.push(<circle key={`h${s.tick}`} cx={s.x} cy={stemEnd + 1} r={3} className="tab-half" />);
      }
      if (s.v.dots > 0) els.push(<circle key={`d${s.tick}`} cx={s.x + 6} cy={stemEnd - 2} r={1.6} className="tab-dot" />);
      if (s.v.triplet) els.push(<text key={`t${s.tick}`} x={s.x} y={stemEnd + 12} textAnchor="middle" className="tab-trip">3</text>);
      i++;
    }
  }
  return <>{els}</>;
}

function articulationGlyph(a: string[]): string {
  const map: Record<string, string> = { staccato: '.', accent: '>', hammer: 'h', pull: 'p', slide: '/', bend: '^', harmonic: '◇', 'palm-mute': 'PM' };
  return a.map((x) => map[x] ?? '').join('');
}

function Systems(props: TabSystemsProps) {
  const { layout, guitar, chords, showChords, showDiagrams, cursor, onStaffPointer } = props;
  const n = layout.nStrings;
  const diagrams = useMemo(() => {
    const m = new Map<string, ReturnType<typeof chordDiagram>>();
    if (showDiagrams)
      for (const c of chords) if (!m.has(c.name)) m.set(c.name, chordDiagram(c.name, guitar.tuning));
    return m;
  }, [chords, guitar.tuning, showDiagrams]);

  return (
    <>
      {layout.systems.map((sys) => {
        const bottom = sys.staffTop + (n - 1) * LINE_GAP;
        const first = sys.measures[0];
        const last = sys.measures[sys.measures.length - 1];
        const x0 = first.x;
        const x1 = last.x + last.w;
        const chordEls: React.ReactNode[] = [];
        let lastEnd = -1e9;
        let lastDiagEnd = -1e9;
        const sysChords = chords.filter((c) => c.tick >= sys.startTick && c.tick < sys.endTick);
        for (const c of sysChords) {
          const f = findSystem(layout, c.tick);
          if (!f) continue;
          const x = tickToX(f.m, c.tick);
          if (showChords && x >= lastEnd) {
            chordEls.push(
              <text key={`c${c.tick}`} x={x - 4} y={sys.chordY + 15} className="chord-name">
                {c.name}
              </text>,
            );
            lastEnd = x + c.name.length * 9 + 6;
          }
          if (showDiagrams && x >= lastDiagEnd) {
            const d = diagrams.get(c.name);
            if (d) {
              chordEls.push(
                <foreignObject key={`d${c.tick}`} x={x - 22} y={sys.diagramY} width={64} height={86}>
                  <ChordDiagramSvg diagram={d} width={64} />
                </foreignObject>,
              );
              lastDiagEnd = x + 66;
            }
          }
        }
        return (
          <g key={sys.index} className="tab-system">
            {chordEls}
            {/* string labels */}
            {guitar.tuning.pitches.map((p, i) => (
              <text key={`l${i}`} x={SIDE_PAD + LABEL_W - 8} y={sys.staffTop + i * LINE_GAP + 4} textAnchor="end" className="string-label">
                {stringLabel(p)}
              </text>
            ))}
            {/* string lines */}
            {guitar.tuning.pitches.map((_, i) => (
              <line key={`s${i}`} x1={x0} x2={x1} y1={sys.staffTop + i * LINE_GAP} y2={sys.staffTop + i * LINE_GAP} className="string-line" />
            ))}
            <line x1={x0} x2={x0} y1={sys.staffTop} y2={bottom} className="barline" />
            {sys.measures.map((m) => {
              const ts = m.measure.timeSignature;
              return (
                <g key={m.measure.index}>
                  <line x1={m.x + m.w} x2={m.x + m.w} y1={sys.staffTop} y2={bottom} className="barline" />
                  <text x={m.x + 3} y={sys.staffTop - 5} className="measure-num">
                    {m.measure.index + 1}
                  </text>
                  {m.showTs && (
                    <g className="ts" transform={`translate(${m.x + 6 + TS_W / 2 - 4}, ${sys.staffTop + (bottom - sys.staffTop) / 2})`}>
                      <text y={-3} textAnchor="middle">{ts.numerator}</text>
                      <text y={15} textAnchor="middle">{ts.denominator}</text>
                    </g>
                  )}
                  <rect
                    x={m.x}
                    y={sys.staffTop - LINE_GAP / 2}
                    width={m.w}
                    height={bottom - sys.staffTop + LINE_GAP}
                    className="staff-hit"
                    onClick={(e) => onStaffPointer(e, sys, m, false)}
                    onDoubleClick={(e) => onStaffPointer(e, sys, m, true)}
                  />
                  {cursor && cursor.tick >= m.measure.startTick && cursor.tick < m.measure.endTick && (
                    <g className="cursor" pointerEvents="none">
                      <line x1={tickToX(m, cursor.tick)} x2={tickToX(m, cursor.tick)} y1={sys.staffTop - 6} y2={bottom + 6} />
                      <circle cx={tickToX(m, cursor.tick)} cy={sys.staffTop + cursor.string * LINE_GAP} r={5} />
                    </g>
                  )}
                  <MeasureNotes m={m} sys={sys} props={props} />
                </g>
              );
            })}
          </g>
        );
      })}
    </>
  );
}

export default memo(Systems);
