import type { ChordDiagram } from '../chords';

interface Props {
  diagram: ChordDiagram;
  /** Pixel width of the diagram */
  width?: number;
  showName?: boolean;
}

const ROWS = 5;

/** Standalone SVG chord box. Strings run low (left) to high (right). */
export default function ChordDiagramSvg({ diagram, width = 64, showName = true }: Props) {
  const n = Math.max(diagram.frets.length, 2);
  const padX = 12;
  const gx = (width - padX * 2) / (n - 1);
  const gy = gx * 1.05;
  const top = showName ? 30 : 16;
  const h = top + ROWS * gy + 8;
  const base = diagram.baseFret || 1;
  const col = (i: number) => padX + (n - 1 - i) * gx; // string 0 is rightmost
  return (
    <svg className="chord-diagram" width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-label={`${diagram.name} chord diagram`}>
      {showName && (
        <text x={width / 2} y={11} textAnchor="middle" className="cd-name">
          {diagram.name}
        </text>
      )}
      {/* nut or base fret label */}
      {base === 1 ? (
        <line x1={padX} x2={width - padX} y1={top} y2={top} className="cd-nut" />
      ) : (
        <text x={padX - 4} y={top + gy * 0.7} textAnchor="end" className="cd-base">
          {base}fr
        </text>
      )}
      {Array.from({ length: ROWS + 1 }, (_, r) => (
        <line key={`r${r}`} x1={padX} x2={width - padX} y1={top + r * gy} y2={top + r * gy} className="cd-line" />
      ))}
      {Array.from({ length: n }, (_, i) => (
        <line key={`c${i}`} x1={padX + i * gx} x2={padX + i * gx} y1={top} y2={top + ROWS * gy} className="cd-line" />
      ))}
      {diagram.barres?.map((b, i) => {
        const row = b.fret - base + 1;
        if (row < 1 || row > ROWS) return null;
        const x1 = col(Math.max(b.from, b.to));
        const x2 = col(Math.min(b.from, b.to));
        return <rect key={i} x={x1 - gx * 0.28} y={top + (row - 0.5) * gy - gx * 0.28} width={x2 - x1 + gx * 0.56} height={gx * 0.56} rx={gx * 0.28} className="cd-dot" />;
      })}
      {diagram.frets.map((f, i) => {
        const x = col(i);
        if (f < 0) return <text key={i} x={x} y={top - 4} textAnchor="middle" className="cd-mark">×</text>;
        if (f === 0) return <circle key={i} cx={x} cy={top - 7} r={gx * 0.2} className="cd-open" />;
        const row = base === 1 ? f : f - base + 1;
        if (row < 1 || row > ROWS) return null;
        const finger = diagram.fingers?.[i];
        return (
          <g key={i}>
            <circle cx={x} cy={top + (row - 0.5) * gy} r={gx * 0.34} className="cd-dot" />
            {finger ? (
              <text x={x} y={top + (row - 0.5) * gy + 3} textAnchor="middle" className="cd-finger">
                {finger}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
