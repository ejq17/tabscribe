/**
 * Scores the JSON written by run.ts against a hand-read ground truth for "Funk Tank" (guitar part, measures 1-8, page 1).
 * Usage: npx tsx scripts/omr-bench/score-funk-tank.ts <bench-json>
 * The chart is in cut time (2/2); pipeline measure numbers are positional and equal the printed numbers. Beats below are QUARTER notes
 * from the printed bar start. Pitches are WRITTEN pitch with the 4-flat key applied (Bb Eb Ab Db); the scorer accepts the written pitch or
 * one octave lower (sounding guitar pitch), whichever explains more of the emitted notes.
 */
import { readFileSync } from 'node:fs';
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (n: string) => { const m = /^([A-G])(b|#)?(\d)$/.exec(n)!; return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0); };
type E = [string, number, number];
// bars 1 and 5: 8th rest, C4 8th, Eb4 (printed E, key flat) 8th, Ab4 8th tied into the 16th Ab4, A natural, Ab again, C4 16ths, Eb4 8th, C4 8th
const riff: E[] = [['C4', 0.5, 0.5], ['Eb4', 1, 0.5], ['Ab4', 1.5, 0.5], ['Ab4', 2, 0.25], ['A4', 2.25, 0.25], ['Ab4', 2.5, 0.25], ['C4', 2.75, 0.25], ['Eb4', 3, 0.5], ['C4', 3.5, 0.5]];
const whole: E[] = [['F4', 0, 4]];
const EXPECT: Record<number, E[]> = { 1: riff, 2: whole, 3: whole, 4: whole, 5: riff, 6: whole, 7: whole, 8: whole };
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
for (const [m, g] of got) for (const x of g) if (!x.used && m <= 8) { extra++; if (!expectedMeasures.has(m)) extraList.push(`m${m}:${nm(x.p)}`); }
console.log(`\nExpected single-line melody notes: ${tot}`);
console.log(`Pitch correct: ${pitchOk}/${tot} (${((100 * pitchOk) / tot).toFixed(0)}%)`);
console.log(`Pitch + onset correct: ${pitchOnsetOk}/${tot}`);
console.log(`Pitch + onset + duration correct: ${exact}/${tot} (${((100 * exact) / tot).toFixed(0)}%)`);
