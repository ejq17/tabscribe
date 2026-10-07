/**
 * OMR corpus benchmark.
 * Usage: npx tsx scripts/omr-bench/corpus-bench.ts [--ids a,b] [--degrade] [--chords] [--seed N] [--json out.json] [--md out.md] [--out DIR]
 * Scores OMR output against the ground-truth MusicXML of every piece in tests/fixtures/omr/corpus.
 * Measurement tool: always exits 0. Crashes in the pipeline are recorded, not thrown.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzePage, assembleScore, recognizeImageDataWithChords } from '../../src/omr/assemble';
import { configureChordOcr, disposeChordOcr } from '../../src/omr/chordtext';
import type { RawImage } from '../../src/omr/types';
import type { Score } from '../../src/core/score';
import { degradeScan } from '../../tests/fixtures/omr/corpus/degrade';
import { dumpMeasures, sanitizeXml, extractTruthMeasures, mean, scorePiece, type PieceMetrics } from './metrics';

// src/importers/midi.ts does `import { Midi } from '@tonejs/midi'`, which node's native ESM linker rejects (CJS build);
// resolve it to the package's ESM build instead. Must be registered before the dynamic import below.
register('./_midi-hook.mjs', import.meta.url);
const { importMusicXml } = await import('../../src/importers/musicxml');

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const CORPUS = resolve(import.meta.dirname ?? '.', '../../tests/fixtures/omr/corpus');

export async function loadPages(dir: string): Promise<RawImage[]> {
  const files = readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
  const out: RawImage[] = [];
  for (const f of files) {
    const img = await loadImage(readFileSync(join(dir, f)));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    out.push({ width: id.width, height: id.height, data: id.data as unknown as Uint8ClampedArray });
  }
  return out;
}

export function runOmr(pages: RawImage[], instrument: 'guitar' | 'concert' = 'concert'): { score: Score; staves: number; ms: number } {
  const t0 = Date.now();
  const results = pages.map((p, i) => analyzePage(p, i));
  const score = assembleScore(results, undefined, { instrument });
  return { score, staves: results.reduce((s, r) => s + r.staves.length, 0), ms: Date.now() - t0 };
}

export async function runOmrChords(pages: RawImage[], instrument: 'guitar' | 'concert' = 'concert'): Promise<{ score: Score; staves: number; ms: number }> {
  const t0 = Date.now();
  const score = await recognizeImageDataWithChords(pages, { instrument });
  return { score, staves: 0, ms: Date.now() - t0 };
}

interface Row {
  id: string;
  mode: 'clean' | 'degraded';
  metrics?: PieceMetrics;
  warnings: number;
  staves: number;
  ms: number;
  crash?: string;
}

async function runOne(id: string, degrade: boolean, seed: number, outDir: string, chords = false): Promise<Row> {
  const dir = join(CORPUS, id);
  const mode = degrade ? 'degraded' : 'clean';
  const row: Row = { id, mode, warnings: 0, staves: 0, ms: 0 };
  try {
    let meta: { instrument?: string } = {};
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* optional */ }
    const xml = sanitizeXml(readFileSync(join(dir, 'score.musicxml'), 'utf8'));
    const truth = importMusicXml(xml);
    const extras = extractTruthMeasures(xml, truth.ppq);
    let pages = await loadPages(dir);
    if (degrade) pages = pages.map((p) => degradeScan(p, { seed }) as unknown as RawImage);
    const inst = meta.instrument === 'guitar' ? 'guitar' : 'concert';
    const { score, staves, ms } = chords ? await runOmrChords(pages, inst) : runOmr(pages, inst);
    row.staves = staves; row.ms = ms;
    row.warnings = (score.meta.warnings ?? []).length;
    row.metrics = scorePiece(truth, score, extras);
    writeFileSync(join(outDir, `${id}.${mode}.txt`), [
      `# ${id} (${mode}) staves=${staves} measures=${row.metrics.measures.recognized}/${row.metrics.measures.truth} pitchF1=${row.metrics.pitch.f1.toFixed(3)}`,
      ...dumpMeasures(score), '', '## truth', ...dumpMeasures(truth, extras.measures.length || undefined), '', '## warnings', ...(score.meta.warnings ?? []),
      ...(chords ? ['', '## chord misses', ...row.metrics.chords.misses.map((x) => `m${x.measure}: truth=${x.truth} read=${x.read}${x.rootOk ? ' (root ok)' : ''}`)] : []),
    ].join('\n'));
  } catch (e: any) {
    row.crash = String(e?.stack ?? e).split('\n').slice(0, 6).join('\n');
  }
  return row;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(0) + '%');

function table(rows: Row[]): string[] {
  const lines = ['| piece | mode | pitch F1 | full F1 | pc F1 | measures ok | key acc | time acc | chords (exact/root) | slash | warn | s |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    if (!r.metrics) { lines.push(`| ${r.id} | ${r.mode} | CRASH | | | | | | | | | |`); continue; }
    const m = r.metrics;
    lines.push(`| ${r.id} | ${r.mode} | ${pct(m.pitch.f1)} | ${pct(m.full.f1)} | ${pct(m.pitchClass.f1)} | ${m.measures.recognized}/${m.measures.truth}${m.measures.correct ? ' ok' : ''} | ${pct(m.key.acc)} | ${pct(m.time.acc)} | ${pct(m.chords.exact)}/${pct(m.chords.root)} | ${m.slash.recall === null ? 'n/a' : `${m.slash.hit}/${m.slash.truth}`}${m.slash.falsePos ? `+${m.slash.falsePos}fp` : ''} | ${r.warnings} | ${(r.ms / 1000).toFixed(1)} |`);
  }
  return lines;
}

function averages(rows: Row[], mode: string) {
  const rs = rows.filter((r) => r.mode === mode);
  const z = (f: (m: PieceMetrics) => number | null) => mean(rs.map((r) => (r.metrics ? f(r.metrics) : 0)));
  return {
    mode, pieces: rs.length, crashes: rs.filter((r) => r.crash).length,
    pitchF1: z((m) => m.pitch.f1), fullF1: z((m) => m.full.f1), pcF1: z((m) => m.pitchClass.f1),
    measuresOk: mean(rs.map((r) => (r.metrics?.measures.correct ? 1 : 0))),
    keyAcc: z((m) => m.key.acc ?? 0), timeAcc: z((m) => m.time.acc ?? 0),
    chordsExact: mean(rs.map((r) => r.metrics?.chords.exact)), chordsRoot: mean(rs.map((r) => r.metrics?.chords.root)),
    warnings: mean(rs.map((r) => r.warnings)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const ids = (opt('--ids')?.split(',') ?? readdirSync(CORPUS).filter((d) => existsSync(join(CORPUS, d, 'score.musicxml')))).sort();
  const withDegrade = args.includes('--degrade');
  const withChords = args.includes('--chords');
  const seed = Number(opt('--seed') ?? 1234);
  const outDir = resolve(opt('--out') ?? join(tmpdir(), 'tabscribe-omr-corpus'));
  mkdirSync(outDir, { recursive: true });
  // keep eng.traineddata out of the repo root (tesseract.js caches into cwd by default)
  if (withChords) configureChordOcr({ cachePath: process.env.TESS_CACHE ?? join(outDir, 'tess-cache') });

  const rows: Row[] = [];
  for (const id of ids) {
    for (const deg of withDegrade ? [false, true] : [false]) {
      const r = await runOne(id, deg, seed, outDir, withChords);
      rows.push(r);
      if (withChords && r.metrics) { const c = r.metrics.chords; console.log(`  chords ${id} ${r.mode}: exact=${pct(c.exact)} root=${pct(c.root)} (${c.measuresWithChords} measures)`); for (const x of c.misses) console.log(`    m${x.measure}: truth=${x.truth} read=${x.read}${x.rootOk ? ' (root ok)' : ''}`); }
      console.log(r.crash ? `CRASH ${id} ${r.mode}\n${r.crash}` : `${id} ${r.mode}: pitchF1=${pct(r.metrics!.pitch.f1)} measures=${r.metrics!.measures.recognized}/${r.metrics!.measures.truth} (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }
  const avgs = [averages(rows, 'clean'), ...(withDegrade ? [averages(rows, 'degraded')] : [])];
  const tbl = table(rows);
  const avgLines = ['| set | pieces | crashes | pitch F1 | full F1 | pc F1 | measures ok | key acc | time acc | chords exact | chords root | avg warn |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...avgs.map((a) => `| ${a.mode} | ${a.pieces} | ${a.crashes} | ${pct(a.pitchF1)} | ${pct(a.fullF1)} | ${pct(a.pcF1)} | ${pct(a.measuresOk)} | ${pct(a.keyAcc)} | ${pct(a.timeAcc)} | ${pct(a.chordsExact)} | ${pct(a.chordsRoot)} | ${a.warnings?.toFixed(1)} |`)];
  console.log('\n' + tbl.join('\n') + '\n\nCorpus averages (crashes count as 0):\n' + avgLines.join('\n'));
  console.log(`\nDumps: ${outDir}`);

  const jsonPath = opt('--json'); if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ date: new Date().toISOString(), seed, rows, averages: avgs }, null, 1));
  const mdPath = opt('--md');
  if (mdPath) writeFileSync(mdPath, `# OMR corpus bench\n\n${tbl.join('\n')}\n\n## Averages\n\n${avgLines.join('\n')}\n`);
}

main().catch((e) => { console.error('bench failed:', e); }).finally(async () => { await disposeChordOcr().catch(() => {}); process.exitCode = 0; });
