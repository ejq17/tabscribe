import { useMemo } from 'react';
import { measuresOf } from '../core';
import { chordDiagram, strumChart } from '../chords';
import { useStore } from '../store';
import ChordDiagramSvg from './ChordDiagramSvg';

export default function StrumChart() {
  const score = useStore((s) => s.score);
  const chords = useStore((s) => s.chords);
  const guitar = useStore((s) => s.guitar);

  const data = useMemo(() => {
    if (!score) return null;
    const lines = strumChart(score, chords);
    const measures = measuresOf(score);
    const slash = new Set((score.meta.omrSlashMeasures ?? []).map((m) => m.tick)) // keyed by start tick, not index;
    const names: string[] = [];
    for (const l of lines) for (const c of l.cells) if (c.chord && !names.includes(c.chord)) names.push(c.chord);
    const diagrams = names.map((n) => ({ name: n, d: chordDiagram(n, guitar.tuning) }));
    return { lines, measures, diagrams, slash };
  }, [score, chords, guitar.tuning]);

  if (!score || !data) return null;
  if (data.lines.length === 0 || data.diagrams.length === 0)
    return <div className="strum print-area"><p className="muted">No chords were detected in this score yet.</p></div>;

  let prev: string | null = null;
  return (
    <div className="strum print-area">
      <h2 className="strum-title">{score.meta.title || 'Chord chart'}</h2>
      <div className="strum-diagrams">
        {data.diagrams.map(({ name, d }) => (
          <figure key={name}>
            {d ? <ChordDiagramSvg diagram={d} width={96} /> : <div className="no-diagram">{name}</div>}
          </figure>
        ))}
      </div>
      <div className="strum-grid">
        {data.lines.map((line) => {
          const byMeasure = new Map<number, typeof line.cells>();
          for (const c of line.cells) {
            const m = data.measures.find((mm) => c.tick >= mm.startTick && c.tick < mm.endTick);
            if (!m) continue;
            const arr = byMeasure.get(m.index) ?? [];
            arr.push(c);
            byMeasure.set(m.index, arr);
          }
          return (
            <div className="strum-line" key={line.measureStart}>
              {[...byMeasure.entries()].map(([mi, cells]) => {
                const isSlash = data.slash.has(data.measures.find((mm) => mm.index === mi)?.startTick ?? -1);
                return (
                <div className="strum-measure" key={mi}>
                  <span className="strum-num">{mi + 1}</span>
                  <div className="strum-cells">
                    {cells.map((c, i) => {
                      // bars written as slashes in the source: empty beats are strummed on the current chord
                      let text = isSlash ? '/' : '·';
                      let cls = isSlash ? 'same' : 'rest';
                      if (c.chord) {
                        if (c.chord === prev) {
                          text = '/';
                          cls = 'same';
                        } else {
                          text = c.chord;
                          cls = 'chord';
                        }
                        prev = c.chord;
                      }
                      return (
                        <span key={i} className={`strum-cell ${cls}`}>
                          {text}
                        </span>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
