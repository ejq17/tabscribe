/**
 * Scores a recognized Score against a hand-read `<name>.truth.json` that sits next to the (git-ignored) scan.
 * Truth format (all bar numbers 1-based, positional = as printed on the scans used here):
 *   measures    total bars
 *   pages       per page, the number of bars (multi-rests count as their length) of each system, top to bottom
 *   multiRests  [[bar, count], ...]
 *   keys        [[bar, fifths], ...]       key signature in force from that bar
 *   meters      [[bar, "3/4"], ...]       bar length only is scored (2/2 == 4/4)
 *   tempo       printed quarter-note tempo or null (unknown / range)
 *   chordRange  [from, to] bars in which the `chords` map is complete (bars without an entry have no chord)
 *   chords      { "bar": ["Fm7", ...] }
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseChordName } from '../../src/chords/shapes';

export interface Truth {
  measures: number;
  pages: number[][];
  multiRests: [number, number][];
  keys: [number, number][];
  meters: [number, string][];
  tempo: number | null;
  chordRange: [number, number];
  chords: Record<string, string[]>;
}

export function loadTruth(pdfPath: string): Truth | undefined {
  const f = join(dirname(pdfPath), `${basename(pdfPath, '.pdf')}.truth.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Truth) : undefined;
}

export interface TruthScore {
  name: string;
  line: string;
  n: Record<string, number>; // numerators / denominators for the total line
  details: string[];
}

const norm = (s: string) => s.replace(/[()\s,]/g, '').replace(/mi(?!n)/g, 'm').replace(/ma(?!j)/g, 'maj').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/^([A-G][#b]?)min/, '$1m').replace(/\+/g, 'aug');

function chordKey(t: string): { root: number | null; full: string } {
  const p = parseChordName(t.replace(/\(add9\)/, 'add9'));
  return { root: p ? p.root : null, full: norm(t) };
}

const same = (a: string, b: string) => { const f = (m: string) => { const [x, y] = m.split('/').map(Number); return x / y; }; return f(a) === f(b); };

export function scoreAgainstTruth(score: any, truth: Truth, name = ''): TruthScore {
  const ppq: number = score.ppq;
  const recTotal: number = score.meta.omrMeasures ?? 0;
  const details: string[] = [];
  const n: Record<string, number> = {};

  // ---- bars per system (aligned page by page, top to bottom)
  const recSys = ((score.meta.omrSystems ?? []) as { page: number; measureCount: number }[]);
  let sysErr = 0, sysExact = 0, sysTotal = 0;
  const sysBad: string[] = [];
  for (let p = 0; p < truth.pages.length; p++) {
    const tr = truth.pages[p];
    const rc = recSys.filter((s) => s.page === p).map((s) => s.measureCount);
    for (let i = 0; i < Math.max(tr.length, rc.length); i++) {
      const t = tr[i] ?? 0, r = rc[i] ?? 0;
      sysErr += Math.abs(t - r);
      if (t !== r) sysBad.push(`p${p + 1}#${i + 1} ${r}/${t}`);
      if (i < tr.length) { sysTotal++; if (t === r) sysExact++; }
    }
  }
  if (sysBad.length) details.push(`system bar counts off (read/truth): ${sysBad.join(' ')}`);
  n.sysExact = sysExact; n.sysTotal = sysTotal; n.sysErr = sysErr; n.barsRec = recTotal; n.barsTruth = truth.measures;

  // ---- multi-rests (global bar numbers, strict; and count-only multiset)
  const rec: [number, number][] = [];
  for (const sys of (score.meta.omrSystems ?? []) as any[]) {
    const cells = sys.cells as { measure: number }[];
    for (let k = 0; k < cells.length; k++) {
      const next = k + 1 < cells.length ? cells[k + 1].measure : sys.firstMeasure + sys.measureCount;
      if (next - cells[k].measure > 1) rec.push([cells[k].measure + 1, next - cells[k].measure]);
    }
  }
  const strict = truth.multiRests.filter(([b, c]) => rec.some(([rb, rc]) => rb === b && rc === c)).length;
  const pool = rec.map((r) => r[1]);
  let loose = 0;
  for (const [, c] of truth.multiRests) { const i = pool.indexOf(c); if (i >= 0) { loose++; pool.splice(i, 1); } }
  n.mrStrict = strict; n.mrLoose = loose; n.mrTruth = truth.multiRests.length; n.mrExtra = rec.length - loose;
  details.push(`multi-rests read ${rec.map((r) => r.join('+')).join(' ') || '-'}`);

  // ---- per-bar key / meter / tempo
  const tsAt = (t: number) => [...score.timeSignatures].filter((x: any) => x.tick <= t).pop() ?? { numerator: 4, denominator: 4 };
  const keyAt = (t: number) => ([...score.keySignatures].filter((x: any) => x.tick <= t).pop() as any)?.fifths ?? 0;
  const starts: number[] = []; const lens: number[] = [];
  { let c = 0; for (let i = 0; i < recTotal; i++) { const ts = tsAt(c); const len = (ppq * 4 * ts.numerator) / ts.denominator; starts.push(c); lens.push(len); c += len; } }
  const truthKey = (bar: number) => ([...truth.keys].filter(([b]) => b <= bar).pop() ?? [1, 0])[1];
  const truthLen = (bar: number) => { const m = ([...truth.meters].filter(([b]) => b <= bar).pop() ?? [1, '4/4'])[1]; const [a, d] = m.split('/').map(Number); return (ppq * 4 * a) / d; };
  let keyOk = 0, meterOk = 0;
  for (let b = 1; b <= truth.measures; b++) {
    if (b <= recTotal && keyAt(starts[b - 1]) === truthKey(b)) keyOk++;
    if (b <= recTotal && lens[b - 1] === truthLen(b)) meterOk++;
  }
  n.keyOk = keyOk; n.meterOk = meterOk; n.bars = truth.measures;
  const keyChanges = (score.keySignatures as any[]).length - 1;
  n.keyChanges = Math.max(0, keyChanges); n.keyChangesTruth = truth.keys.filter(([, f], i, a) => i > 0 && f !== a[i - 1][1]).length;
  const tsChanges = [...(score.timeSignatures as any[])].filter((t, i, a) => i > 0 && (a[i - 1].numerator * 4) / a[i - 1].denominator !== (t.numerator * 4) / t.denominator).length;
  n.meterChanges = tsChanges; n.meterChangesTruth = truth.meters.filter(([, m], i, a) => i > 0 && !same(m, a[i - 1][1])).length;
  const bpm = (score.tempos ?? [])[0]?.bpm;
  const tempoOk = truth.tempo == null ? undefined : bpm === truth.tempo;
  n.tempoTruth = truth.tempo == null ? 0 : 1; n.tempoOk = tempoOk ? 1 : 0;
  details.push(`keys read ${(score.keySignatures as any[]).map((k) => `${k.fifths}@${starts.findIndex((s) => s >= k.tick) + 1}`).join(',')}`);

  // ---- chords (symbol in the right bar)
  const [lo, hi] = truth.chordRange;
  const recChords = ((score.meta.omrChords ?? []) as { measure: number; text: string }[]).map((c) => ({ bar: c.measure + 1, text: c.text, used: false })).filter((c) => c.bar >= lo && c.bar <= hi);
  let full = 0, root = 0, total = 0;
  const miss: string[] = [];
  for (const [bs, syms] of Object.entries(truth.chords)) {
    const bar = Number(bs);
    for (const t of syms) {
      total++;
      const tk = chordKey(t);
      const cand = recChords.filter((c) => c.bar === bar && !c.used);
      const f = cand.find((c) => chordKey(c.text).full === tk.full);
      const r = f ?? cand.find((c) => tk.root !== null && chordKey(c.text).root === tk.root);
      if (f) { f.used = true; full++; root++; }
      else if (r) { r.used = true; root++; miss.push(`m${bar} ${t} read ${r.text}`); }
      else miss.push(`m${bar} ${t} missing`);
    }
  }
  n.chFull = full; n.chRoot = root; n.chTruth = total; n.chExtra = recChords.filter((c) => !c.used).length;
  if (miss.length) details.push(`chord misses: ${miss.slice(0, 14).join('; ')}${miss.length > 14 ? ` (+${miss.length - 14})` : ''}`);

  const res: TruthScore = { name, line: '', n, details };
  res.line = `${name.replace('-guitar', '').replace('.pdf', '').padEnd(28)} ${formatTruthScore(res, truth)[0].replace('TRUTH ', '')}`;
  return res;
}

export function formatTruthScore(s: TruthScore, _t: Truth): string[] {
  const n = s.n;
  return [`TRUTH bars ${n.barsRec}/${n.barsTruth} (per-system |err| ${n.sysErr}, systems exact ${n.sysExact}/${n.sysTotal}) | multi-rest exact ${n.mrStrict}/${n.mrTruth} (count-only ${n.mrLoose}, extra ${n.mrExtra}) | key bars ${n.keyOk}/${n.bars} (changes ${n.keyChanges} vs ${n.keyChangesTruth}) | meter bars ${n.meterOk}/${n.bars} (changes ${n.meterChanges} vs ${n.meterChangesTruth}) | tempo ${n.tempoTruth ? (n.tempoOk ? 'ok' : 'WRONG') : 'n/a'} | chords symbol ${n.chFull}/${n.chTruth}, root ${n.chRoot}/${n.chTruth}, extra ${n.chExtra}`, ...s.details];
}

export function sumTruthScores(list: TruthScore[]): string {
  const t: Record<string, number> = {};
  for (const s of list) for (const [k, v] of Object.entries(s.n)) t[k] = (t[k] ?? 0) + v;
  return `TOTAL bars ${t.barsRec}/${t.barsTruth}, systems exact ${t.sysExact}/${t.sysTotal} (|err| ${t.sysErr}) | multi-rest exact ${t.mrStrict}/${t.mrTruth} (extra ${t.mrExtra}) | key bars ${t.keyOk}/${t.bars} | meter bars ${t.meterOk}/${t.bars} | tempo ${t.tempoOk}/${t.tempoTruth} | chords symbol ${t.chFull}/${t.chTruth}, root ${t.chRoot}/${t.chTruth}, extra ${t.chExtra}`;
}

export interface ChordEvidence {
  bar: number;
  /** 1-based page */
  page: number;
  text: string;
  confidence: number;
  ocrConf?: number;
  repaired?: boolean;
  /** kept = in meta.omrChords; false = withheld by the reliability rule (meta.omrChordsSuppressed) */
  kept: boolean;
  /** exact symbol (after normalisation) printed in that bar per the truth */
  ok: boolean;
}

/** Every OCR chord label (kept or suppressed) inside the truth's complete `chordRange`, judged against the truth. Text-layer chords carry no `ocrConf` and are skipped. */
export function chordEvidence(score: any, truth: Truth): ChordEvidence[] {
  const [lo, hi] = truth.chordRange;
  const rows: ChordEvidence[] = [];
  const add = (list: any[] | undefined, kept: boolean) => {
    for (const c of list ?? []) {
      if (c.ocrConf === undefined) continue;
      const bar = c.measure + 1;
      if (bar < lo || bar > hi) continue;
      const ok = (truth.chords[String(bar)] ?? []).some((t) => chordKey(t).full === chordKey(c.text).full);
      const sys = ((score.meta.omrSystems ?? []) as any[]).find((x) => c.measure >= x.firstMeasure && c.measure < x.firstMeasure + x.measureCount);
      rows.push({ bar, page: (sys?.page ?? 0) + 1, text: c.text, confidence: c.confidence, ocrConf: c.ocrConf, repaired: c.repaired, kept, ok });
    }
  };
  add(score.meta.omrChords, true);
  add(score.meta.omrChordsSuppressed, false);
  return rows;
}

/** kept / correct-kept / wrong-kept / correct-lost / wrong-removed counts of a set of evidence rows. */
export function tallyEvidence(rows: ChordEvidence[]): { kept: number; keptOk: number; keptWrong: number; lostOk: number; removedWrong: number; all: number; allOk: number } {
  const t = { kept: 0, keptOk: 0, keptWrong: 0, lostOk: 0, removedWrong: 0, all: rows.length, allOk: 0 };
  for (const r of rows) {
    if (r.ok) t.allOk++;
    if (r.kept) { t.kept++; if (r.ok) t.keptOk++; else t.keptWrong++; } else if (r.ok) t.lostOk++; else t.removedWrong++;
  }
  return t;
}

/** Page-1 chord truth of a-child-is-born-guitar.pdf (same as chordtext-probe.ts), keyed by 1-based staff number on page 1. */
export const A_CHILD_PAGE1_TRUTH: Record<number, string[]> = {
  2: ['Bbmaj7'],
  3: ['Ebm6/F', 'Bbmaj7', 'Ebm6/F', 'Bbmaj7', 'Ebm6/F'],
  4: ['Bbmaj7', 'Ebm6/F', 'Bbmaj7', 'Ebm6/F', 'Am11', 'D7b9b5'],
  5: ['Gmadd2', 'D7b9', 'Gmadd2', 'D7b9', 'Gmadd2', 'Gm7', 'C9'],
  6: ['Cm9', 'F9', 'Bbmaj7', 'Ebm6/Bb', 'Bbmaj7', 'Ebm6/Bb'],
  7: ['Bbmaj7', 'D7#9#5', 'Ebmaj7', 'Ab9', 'Bb/F', 'Ebm6/Gb'],
  8: ['Gm7', 'C9', 'Cm7'],
};

/** Evidence for page-1 OCR labels judged per system against a per-staff truth list (order-free; each truth symbol is used once). Staff k of page 1 is system k-1 (staff 1 = system 0). */
export function chordEvidenceByStaff(score: any, truthByStaff: Record<number, string[]>, page = 0): ChordEvidence[] {
  const systems = ((score.meta.omrSystems ?? []) as any[]).filter((s) => s.page === page);
  const rows: ChordEvidence[] = [];
  for (const [list, kept] of [[score.meta.omrChords, true], [score.meta.omrChordsSuppressed, false]] as const) {
    const pool: Record<number, string[]> = {};
    for (const [k, v] of Object.entries(truthByStaff)) pool[Number(k)] = v.map(norm);
    for (const c of (list ?? []) as any[]) {
      if (c.ocrConf === undefined) continue;
      const si = systems.findIndex((x) => c.measure >= x.firstMeasure && c.measure < x.firstMeasure + x.measureCount);
      if (si < 0) continue;
      const p = pool[si + 1] ?? [];
      const i = p.indexOf(norm(c.text));
      if (i >= 0) p.splice(i, 1);
      rows.push({ bar: c.measure + 1, page: page + 1, text: c.text, confidence: c.confidence, ocrConf: c.ocrConf, repaired: c.repaired, kept, ok: i >= 0 });
    }
  }
  return rows;
}
