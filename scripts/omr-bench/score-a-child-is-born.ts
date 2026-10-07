/**
 * Scores the JSON written by run.ts against a hand-read ground truth for "A Child Is Born" (guitar part).
 * Usage: npx tsx scripts/omr-bench/score-a-child-is-born.ts <bench-json>
 * Pipeline measure numbers are positional and now match the printed numbers one to one. Beats are quarter notes from the printed bar start.
 */
import { readFileSync } from 'node:fs';

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (n: string) => { const m = /^([A-G])(b|#)?(\d)$/.exec(n)!; return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0); };
type E = [string, number, number];
const m120: E[] = [['Ab4', 0, 1], ['Bb4', 1, 1], ['Eb5', 2, 1]];
const m49: E[] = [['D5', 0, 1.5], ['D5', 1.5, 0.5]];
const EXPECT: Record<number, E[]> = {
  1: [['D4', 0, 3]], 2: [['Eb4', 0, 1], ['F4', 1, 1], ['Bb4', 2, 1]],
  3: [['F4', 0, .5], ['G4', .5, .5], ['A4', 1, .5], ['Bb4', 1.5, .5], ['C5', 2, .5], ['D5', 2.5, .5]],
  4: [['F5', 0, 2], ['Eb5', 2, 1]], 5: [['Bb4', 1, .5], ['C5', 1.5, .5], ['Bb4', 2, .5], ['C5', 2.5, .5]],
  6: [['D5', 0, .5], ['Eb5', .5, .5], ['D5', 1, .5], ['Eb5', 1.5, .5], ['F5', 2, .5], ['E5', 2.5, .5]],
  7: [['Eb5', 0, 1], ['D5', 1, 1], ['C5', 2, 1]], 8: [['D5', 0, 3]],
  46: [['G4', 1, .5], ['A4', 1.5, .5], ['Bb4', 2, .5], ['C5', 2.5, .5]], 47: m49, 48: [['F5', .5, 1.5], ['D5', 2, 1]],
  49: m49, 50: [['F5', .5, 1.5], ['Eb5', 2, 1]], 51: m49, 52: [['G4', .5, 1], ['Bb4', 1.5, 1], ['C5', 2.5, .5]],
  53: [['D5', 0, 1.5], ['B4', 1.5, .5], ['B4', 2, 1]], 54: [['B4', 0, 2]],
  119: [['G4', 0, 3]], 120: m120, 121: [['G4', 0, 3]], 122: m120, 123: [['G4', 0, 3]], 124: m120, 125: [['G5', 0, 3]], 126: [['F5', 0, 3]],
  127: [['G4', 0, 3]], 128: m120, 129: [['G4', 0, 3]], 130: m120, 131: [['G4', 0, 3]], 132: [['A4', 0, 1], ['Bb4', 1, 1], ['Eb5', 2, 1]],
  133: [['G5', 0, 3]], 134: [['Bb4', 0, 2], ['Ab4', 2, 1]],
  157: [['E4', 0, 3]], 158: [['G4', 0, 1], ['B4', 1, 1], ['D5', 2, 1]], 159: [['G5', 0, 3]], 160: [['F5', 0, 3]], 161: [['E5', 0, 3]],
};
/** Measure numbering is exact now (pipeline measure == printed measure), so no offset table is needed. */
const printed = (pos: number): number => pos;
const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ppq: number = j.score.ppq;
const notes = j.score.tracks.flatMap((t: any) => t.notes) as { pitch: number; start: number; duration: number }[];
const bounds = j.bounds as { n: number; start: number; len: number }[];
const got = new Map<number, { p: number; s: number; d: number; used: boolean }[]>();
for (const n of notes) {
  const b = bounds.find((x) => n.start >= x.start && n.start < x.start + x.len)!;
  const m = printed(b.n);
  if (!got.has(m)) got.set(m, []);
  got.get(m)!.push({ p: n.pitch, s: (n.start - b.start) / ppq, d: n.duration / ppq, used: false });
}
// The assembler may emit SOUNDING pitch (guitar: written treble minus an octave) while the truth below is written pitch.
// Pick the octave offset (0 or -12) that explains more of the emitted notes overall.
const histo = new Map<number, number>();
for (const n of notes) histo.set(n.pitch, (histo.get(n.pitch) ?? 0) + 1);
const expectedPitches = Object.values(EXPECT).flat().map(([name]) => midi(name));
const hits = (off: number) => expectedPitches.filter((p) => histo.has(p + off)).length;
const OCT = hits(-12) > hits(0) ? -12 : 0;
if (OCT) console.log('(emitted pitches are one octave below the written truth: comparing against written - 12)');
let tot = 0, pitchOk = 0, exact = 0, pitchOnsetOk = 0;
const rows: string[] = ['| m | expected | got | pitch ok | + start ok | + dur ok |', '|---|---|---|---|---|---|'];
const fmt = (a: string, s: number, d: number) => `${a}@${s}x${d}`;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nm = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
for (const [ms, exp] of Object.entries(EXPECT)) {
  const m = Number(ms);
  const g = got.get(m) ?? [];
  let po = 0, so = 0, ex = 0;
  for (const [name, s, d] of exp) {
    tot++;
    const cand = g.filter((x) => !x.used && x.p === midi(name) + OCT);
    if (cand.length) {
      pitchOk++; po++;
      cand.sort((a, b) => Math.abs(a.s - s) - Math.abs(b.s - s));
      const c = cand[0]; c.used = true;
      if (Math.abs(c.s - s) <= 0.13) { pitchOnsetOk++; so++; if (Math.abs(c.d - d) <= 0.13) { exact++; ex++; } }
    }
  }
  rows.push(`| ${m} | ${exp.map((e) => fmt(...e)).join(' ')} | ${g.map((x) => fmt(nm(x.p), +x.s.toFixed(2), +x.d.toFixed(2))).join(' ') || '-'} | ${po}/${exp.length} | ${so}/${exp.length} | ${ex}/${exp.length} |`);
}
console.log(rows.join('\n'));
const expectedMeasures = new Set(Object.keys(EXPECT).map(Number));
let extra = 0; const extraList: string[] = [];
for (const [m, g] of got) for (const x of g) if (!x.used && m !== 162) { extra++; if (!expectedMeasures.has(m)) extraList.push(`m${m}:${nm(x.p)}`); }
console.log(`\nExpected single-line melody notes: ${tot}`);
console.log(`Pitch correct: ${pitchOk}/${tot} (${((100 * pitchOk) / tot).toFixed(0)}%)`);
console.log(`Pitch + onset correct: ${pitchOnsetOk}/${tot}`);
console.log(`Pitch + onset + duration correct: ${exact}/${tot} (${((100 * exact) / tot).toFixed(0)}%)`);
console.log(`Unmatched emitted notes (excl. m162 chord): ${extra}; of which in measures with no expected notes: ${extraList.join(' ') || 'none'}`);
const chord = got.get(162) ?? [];
console.log(`m162 got: ${chord.map((x) => nm(x.p) + '@' + x.s.toFixed(2) + 'x' + x.d.toFixed(2)).join(' ')}`);
// the final rolled chord is scored structurally (the exact pitch list is not hand-verified): one onset at the barline, held 3 beats
const onsets = new Set(chord.map((x) => x.s.toFixed(1)));
console.log(`m162 chord: ${chord.length} notes, ${onsets.size} onset(s), ${chord.every((x) => Math.abs(x.s) <= 0.13 && Math.abs(x.d - 3) <= 0.13) ? 'PASS (single onset, 3 beats)' : 'FAIL (expected one onset at beat 0 held 3 beats)'}`);
