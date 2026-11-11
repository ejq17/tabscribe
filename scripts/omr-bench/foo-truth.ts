/**
 * Ground truth for the digital Foo Birds chord chart, derived from the PDF text layer ONLY (independent of the OMR pipeline):
 * each chord's bar is the printed bar number at the start of the cell it sits over (small grey digits below the staff, same row),
 * its beat is the chord's x position inside that cell (two chords per bar -> beats 1 and 3).
 */
export interface TextItem { str: string; x: number; y: number; w: number; h: number }
export interface TruthChord { measure: number; text: string; beat: number }

const CHORD = /^[A-G][♭♯b#]?(?:maj|m|min|dim|aug|°|ø|sus|add|\+|-)?[0-9]*(?:\([^)]*\))?(?:\/[A-G][♭♯b#]?)?$/;
const norm = (s: string) => s.replace(/♭/g, 'b').replace(/♯/g, '#').replace(/[()]/g, '').replace(/,/g, '').replace(/°/g, 'dim');

/** items per page (canvas pixels, scale 2.5) -> truth chords (0-based measure, beat 0..3 of 4) */
export function chordTruth(items: TextItem[][]): TruthChord[] {
  const truth: TruthChord[] = [];
  for (const its of items) {
    // bar numbers are the small grey digits (h <= 19); multi-rest counts are bold and larger
    const bar = its.filter((i) => /^\d{1,3}$/.test(i.str.trim()) && i.h > 0 && i.h <= 19 && i.w < 40).map((i) => ({ n: Number(i.str), x: i.x, y: i.y }));
    const rows = [...new Set(bar.map((n) => Math.round(n.y)))].sort((a, b) => a - b);
    for (const c of its.filter((i) => CHORD.test(i.str.trim()))) {
      const row = rows.find((r) => r > c.y && r - c.y < 220);
      if (row === undefined) continue;
      const inRow = bar.filter((n) => Math.abs(n.y - row) < 3).sort((a, b) => a.x - b.x);
      let cell = inRow[0];
      for (const n of inRow) if (n.x - 12 <= c.x) cell = n;
      const next = inRow.find((n) => n.x > cell.x);
      const start = cell.x - 10;
      const end = next ? next.x - 10 : 1455;
      const frac = (c.x - start) / (end - start);
      truth.push({ measure: cell.n - 1, text: norm(c.str.trim()), beat: Math.min(3, Math.max(0, Math.round(frac * 4))) });
    }
  }
  return truth;
}

export interface ChordComparison { total: number; exact: number; symOk: number; barOk: number; extra: number; miss: string[] }

/** Compare `score.meta.omrChords` with the truth (4/4 grid: the chart is in cut time, read as four quarters per bar). */
export function compareChords(truth: TruthChord[], score: { ppq: number; meta: { omrChords?: { measure: number; tick: number; text: string }[] } }): ChordComparison {
  const rec = score.meta.omrChords ?? [];
  const used = new Set<number>();
  const r: ChordComparison = { total: truth.length, exact: 0, symOk: 0, barOk: 0, extra: 0, miss: [] };
  for (const t of truth) {
    const j = rec.findIndex((x, k) => !used.has(k) && x.measure === t.measure && x.text === t.text);
    const jb = rec.findIndex((x, k) => !used.has(k) && x.measure === t.measure);
    if (j >= 0) {
      used.add(j);
      r.symOk++;
      r.barOk++;
      const beat = Math.round((rec[j].tick - score.ppq * 4 * t.measure) / score.ppq);
      if (beat === t.beat) r.exact++;
      else r.miss.push(`m${t.measure + 1} ${t.text} beat ${beat + 1} (want ${t.beat + 1})`);
    } else {
      if (jb >= 0) r.barOk++;
      r.miss.push(`m${t.measure + 1} ${t.text} -> ${jb >= 0 ? rec[jb].text : 'missing'}`);
    }
  }
  r.extra = rec.length - used.size;
  return r;
}
