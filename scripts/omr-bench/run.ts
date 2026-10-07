/**
 * Node harness for the browser OMR pipeline.
 * Usage: npx tsx scripts/omr-bench/run.ts <file.pdf> [--scale 2.5] [--out DIR] [--json]
 * Renders PDF pages with pdf.js onto @napi-rs/canvas, runs analyzePage + assembleScore, dumps per-measure results.
 */
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePage, assembleScore } from '../../src/omr/assemble';
import { staffMeasures } from '../../src/omr/rhythm';
import type { RawImage } from '../../src/omr/types';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.pdf'));
if (!file) throw new Error('usage: run.ts <file.pdf> [--scale N] [--out DIR] [--json] [--instrument guitar|concert]');
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const instrument = opt('--instrument', 'concert') === 'guitar' ? 'guitar' : 'concert';
const scale = Number(opt('--scale', '2.5'));
const outDir = opt('--out', '/private/tmp/claude-501/-Users-ejquigley-Documents-Projects-Sheet-Music-to-Guitar-Tabs/5ecd0d2c-4e15-4b1e-94a8-3cd0301c1a16/scratchpad/bench');
mkdirSync(outDir, { recursive: true });

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nm = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

async function render(): Promise<RawImage[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file!)), disableWorker: true, useSystemFonts: true, verbosity: 0 } as any).promise;
  const out: RawImage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    let vp = page.getViewport({ scale });
    const longest = Math.max(vp.width, vp.height);
    if (longest > 4000) vp = page.getViewport({ scale: (scale * 4000) / longest });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any } as any).promise;
    writeFileSync(`${outDir}/${basename(file!, '.pdf')}-p${i}.png`, canvas.toBuffer('image/png'));
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    out.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
    page.cleanup();
  }
  return out;
}

const pages = await render();
console.log(`Rendered ${pages.length} pages: ${pages.map((p) => `${p.width}x${p.height}`).join(', ')}  (PNGs in ${outDir})`);
const results = pages.map((p, i) => analyzePage(p, i));
const score = assembleScore(results, undefined, { instrument });
const ppq = score.ppq;

// measure boundaries from time-signature map
const tsAt = (t: number) => [...score.timeSignatures].filter((x) => x.tick <= t).pop() ?? { tick: 0, numerator: 4, denominator: 4 };
const total = (score.meta.omrMeasures as number) ?? 0;
const bounds: { n: number; start: number; len: number }[] = [];
{ let c = 0; for (let n = 1; n <= total; n++) { const ts = tsAt(c); const len = (ppq * 4 * ts.numerator) / ts.denominator; bounds.push({ n, start: c, len }); c += len; } }
const keyAt = (t: number) => [...score.keySignatures].filter((x) => x.tick <= t).pop();

console.log('\n=== PER-PAGE SYMBOL SUMMARY ===');
results.forEach((r, pi) => {
  console.log(`Page ${pi + 1}: ${r.staves.length} staves, ${r.systems.length} systems`);
  r.symbols.forEach((s, si) => {
    console.log(`  staff ${si + 1}: clef=${s.clef}${s.clefDetected ? '' : '(inherit/default)'} key=${s.keyFifths} ts=${s.timeSig ? s.timeSig.numerator + '/' + s.timeSig.denominator : '-'}${s.timeSigUnreadable ? '(unreadable)' : ''} heads=${s.heads.length} rests=${s.rests.map((x) => x.kind + (x.dots ? '.' : '')).join(',') || '-'} bars=${s.barlines.length} slashes=${s.slashes?.length ?? 0} multiRests=${(s.multiRests ?? []).map((m) => m.count + (m.guessed ? '?' : '')).join(',') || '-'} tuplets=${s.tuplets?.length ?? 0} tieOut=${s.tieOuts?.length ?? (s.tieOut ? 1 : 0)}`);
  });
});

console.log('\n=== PER-SYSTEM (positional measure range as the assembler counts them) ===');
{
  let pos = 1;
  results.forEach((r, pi) => r.systems.forEach((sys, k) => {
    let count = 0;
    for (const si of sys) count = Math.max(count, staffMeasures(r.symbols[si], r.symbols[si].stems, r.staves[si].staffSpace, ppq).length);
    const sy = r.symbols[sys[0]];
    console.log(`p${pi + 1} sys${k + 1}: positional m${pos}..m${pos + Math.max(1, count) - 1} (cells=${count}, barlines=${sy.barlines.length}, multiRests=${(sy.multiRests ?? []).map((m) => m.count + (m.guessed ? '?' : '')).join(',') || '-'}, slashes=${sy.slashes?.length ?? 0}, heads=${sy.heads.length}, rests=${sy.rests.map((x) => x.kind[0] + (x.dots ? '.' : '')).join('')})`);
    pos += Math.max(1, count);
  }));
}
console.log('\n=== PER-MEASURE (measure numbers are positional, from the assembler cursor) ===');
const notes = score.tracks.flatMap((t) => t.notes);
for (const b of bounds) {
  const ts = tsAt(b.start); const k = keyAt(b.start);
  const prev = tsAt(b.start - 1); const pk = keyAt(Math.max(0, b.start - 1));
  const flags = [b.start === 0 || ts !== prev ? `TS ${ts.numerator}/${ts.denominator}` : '', b.start === 0 || k !== pk ? `KEY ${k?.fifths}` : ''].filter(Boolean).join(' ');
  const ns = notes.filter((n) => n.start >= b.start && n.start < b.start + b.len).sort((a, c) => a.start - c.start || c.pitch - a.pitch);
  const desc = ns.map((n) => `${nm(n.pitch)}@${((n.start - b.start) / ppq).toFixed(2)}x${(n.duration / ppq).toFixed(2)}${n.tiedFromPrevious ? '~' : ''}${(n.confidence ?? 1) < 0.8 ? '?' : ''}`).join(' ');
  console.log(`m${b.n}${flags ? ' [' + flags + ']' : ''}: ${desc || '(no notes)'}`);
}
console.log(`\nTotal measures: ${total}, notes: ${notes.length}`);
console.log('\n=== WARNINGS ===');
for (const w of score.meta.warnings ?? []) console.log('- ' + w);
writeFileSync(`${outDir}/${basename(file!, '.pdf')}.json`, JSON.stringify({ score: { ...score, meta: { ...score.meta, omrBoxes: undefined } }, bounds }, null, 1));
