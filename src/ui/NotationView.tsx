import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Accidental, Beam, Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow';
import { keyName, keySignatureAt, measuresOf, spellPitch, type Note, type Score } from '../core';
import { useStore } from '../store';
import { guitarNotes } from '../store/ops';
import { useWidth } from './useWidth';

class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.err) return <p className="muted pad">Standard notation couldn’t be drawn for this score ({this.state.err}). The tab is unaffected.</p>;
    return this.props.children;
  }
}

const DURS: [number, string][] = [
  [4, 'w'],
  [3, 'hd'],
  [2, 'h'],
  [1.5, 'qd'],
  [1, 'q'],
  [0.75, '8d'],
  [0.5, '8'],
  [0.375, '16d'],
  [0.25, '16'],
  [0.125, '32'],
];

function decompose(ticks: number, ppq: number): string[] {
  const out: string[] = [];
  let rem = ticks / ppq;
  for (let guard = 0; guard < 12 && rem >= 0.1; guard++) {
    const d = DURS.find(([q]) => q <= rem + 1e-6);
    if (!d) break;
    out.push(d[1]);
    rem -= d[0];
  }
  return out;
}

function vexKey(n: Note, score: Score): string {
  const sp = n.spelling ?? spellPitch(n.pitch, keySignatureAt(score, n.start));
  const acc = sp.alter > 0 ? '#'.repeat(sp.alter) : sp.alter < 0 ? 'b'.repeat(-sp.alter) : '';
  return `${sp.step.toLowerCase()}${acc}/${sp.octave + 1}`; // written an octave above sounding pitch
}

function keySpec(score: Score, tick: number): string {
  const ks = keySignatureAt(score, tick);
  const [root] = keyName(ks).split(' ');
  return ks.mode === 'minor' ? `${root}m` : root;
}

function pitchOfKey(k: string): number {
  const m = /^([a-g])(#*|b*)\/(-?\d+)$/.exec(k)!;
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const alt = m[2].startsWith('#') ? m[2].length : -m[2].length;
  return (parseInt(m[3], 10) + 1) * 12 + base[m[1]] + alt;
}

function draw(host: HTMLDivElement, score: Score, width: number) {
  host.innerHTML = '';
  const ppq = score.ppq;
  const measures = measuresOf(score);
  const notes = guitarNotes(score);
  const widths = measures.map((m) => {
    const onsets = new Set(notes.filter((n) => n.start >= m.startTick && n.start < m.endTick).map((n) => n.start)).size;
    return Math.max(110, onsets * 38 + 50);
  });
  const avail = Math.max(260, width - 20);
  const lines: number[][] = [];
  let cur: number[] = [];
  let sum = 0;
  widths.forEach((w, i) => {
    const extra = cur.length === 0 ? 70 : 0;
    if (cur.length && sum + w + extra > avail) {
      lines.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(i);
    sum += w + (cur.length === 1 ? 70 : 0);
  });
  if (cur.length) lines.push(cur);

  const lineH = 140;
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(width, lines.length * lineH + 20);
  const ctx = renderer.getContext();

  lines.forEach((idxs, li) => {
    const lead = 70;
    const total = idxs.reduce((a, i) => a + widths[i], 0) + lead;
    const scale = li === lines.length - 1 ? Math.min(1.2, (avail) / total) : avail / total;
    let x = 10;
    idxs.forEach((mi, pos) => {
      const m = measures[mi];
      const w = widths[mi] * scale + (pos === 0 ? lead * scale : 0);
      const stave = new Stave(x, li * lineH + 20, w);
      const prev = measures[mi - 1];
      if (pos === 0) {
        stave.addClef('treble', 'default', '8vb');
        stave.addKeySignature(keySpec(score, m.startTick));
      }
      if (mi === 0 || (prev && (prev.timeSignature.numerator !== m.timeSignature.numerator || prev.timeSignature.denominator !== m.timeSignature.denominator)))
        stave.addTimeSignature(`${m.timeSignature.numerator}/${m.timeSignature.denominator}`);
      stave.setMeasure(mi + 1);
      stave.setContext(ctx).draw();

      const groups = new Map<number, Note[]>();
      for (const n of notes) if (n.start >= m.startTick && n.start < m.endTick) (groups.get(n.start) ?? groups.set(n.start, []).get(n.start)!).push(n);
      const onsets = [...groups.keys()].sort((a, b) => a - b);
      const sn: StaveNote[] = [];
      let tick = m.startTick;
      const rest = (len: number) => {
        for (const d of decompose(len, ppq)) {
          const r = new StaveNote({ keys: ['b/4'], duration: `${d}r` });
          if (d.endsWith('d')) Dot.buildAndAttach([r], { all: true });
          sn.push(r);
        }
      };
      onsets.forEach((t, k) => {
        if (t > tick) rest(t - tick);
        const g = groups.get(t)!;
        const nextOnset = onsets[k + 1] ?? m.endTick;
        const len = Math.max(ppq / 8, Math.min(Math.min(...g.map((n) => n.duration)), nextOnset - t));
        const ds = decompose(len, ppq);
        const keys = g.map((n) => vexKey(n, score)).sort((a, b) => pitchOfKey(a) - pitchOfKey(b));
        ds.slice(0, 1).forEach((d) => {
          const note = new StaveNote({ keys, duration: d });
          if (d.endsWith('d')) Dot.buildAndAttach([note], { all: true });
          sn.push(note);
        });
        tick = t + (ds.length ? len : 0);
        const covered = ds.length ? ds.slice(1) : [];
        for (const d of covered) {
          const r = new StaveNote({ keys: ['b/4'], duration: `${d}r` });
          sn.push(r);
        }
      });
      if (tick < m.endTick) rest(m.endTick - tick);
      if (sn.length === 0) return;
      const voice = new Voice({ numBeats: m.timeSignature.numerator, beatValue: m.timeSignature.denominator }).setMode(Voice.Mode.SOFT);
      voice.addTickables(sn);
      Accidental.applyAccidentals([voice], keySpec(score, m.startTick));
      const beams = Beam.generateBeams(sn);
      new Formatter().joinVoices([voice]).format([voice], Math.max(40, stave.getNoteEndX() - stave.getNoteStartX() - 12));
      voice.draw(ctx, stave);
      beams.forEach((b) => b.setContext(ctx).draw());
      x += w;
    });
  });
}

function Inner() {
  const score = useStore((s) => s.score);
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!score || !hostRef.current) return;
    try {
      draw(hostRef.current, score, width);
      setErr(null);
    } catch (e) {
      console.warn('VexFlow render failed', e);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [score, width]);
  return (
    <div className="notation" ref={ref}>
      {err && <p className="muted pad">Standard notation couldn’t be drawn for this score ({err}). The tab is unaffected.</p>}
      <div ref={hostRef} />
    </div>
  );
}

export default function NotationView() {
  return (
    <section className="notation-wrap" aria-label="Standard notation">
      <h2 className="pane-title">Standard notation</h2>
      <Boundary>
        <Inner />
      </Boundary>
    </section>
  );
}
