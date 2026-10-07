/**
 * Rebuilds the redistributable OMR benchmark corpus in tests/fixtures/omr/corpus/.
 *
 *   npx tsx scripts/omr-corpus/build-corpus.ts            # build everything
 *   npx tsx scripts/omr-corpus/build-corpus.ts greensleeves lieder-satie-chanson   # only these ids
 *   npx tsx scripts/omr-corpus/build-corpus.ts --refresh  # re-download sources
 *
 * Requires MuseScore 4 (set MSCORE=/path/to/mscore to override) and poppler's pdftoppm
 * (only for the Mutopia pieces). Downloads are cached outside the repo (os.tmpdir()) and are
 * treated as untrusted data: they are only ever passed as arguments to mscore / pdftoppm.
 *
 * Output per piece: score.musicxml, page-N.png (150 dpi, 8-bit grayscale), meta.json
 * (+ source.pdf / source.mid / source.ly for the Mutopia pieces).
 */
import { spawnSync } from 'node:child_process'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const corpusDir = join(repoRoot, 'tests', 'fixtures', 'omr', 'corpus')
const cacheDir = join(tmpdir(), 'tabscribe-omr-corpus-cache')
const DPI = 150

const LIEDER_COMMIT = '38c5db510224d9facdc4b08d741fc788cfb58ea8'
const lieder = (path: string) =>
  `https://raw.githubusercontent.com/OpenScore/Lieder/${LIEDER_COMMIT}/` +
  path.split('/').map(encodeURIComponent).join('/')
const MUTOPIA = 'https://www.mutopiaproject.org/ftp/'

type Entry =
  | { kind: 'lieder'; id: string; title: string; composer: string; path: string; note?: string }
  | { kind: 'mutopia'; id: string; title: string; composer: string; dir: string; base: string; note?: string }
  | { kind: 'leadsheet'; id: string; title: string; composer: string; file: string; note?: string }

const ENTRIES: Entry[] = [
  { kind: 'lieder', id: 'lieder-zumsteeg-geburtstag', title: 'Der Geburtstag', composer: 'Emilie Zumsteeg', path: 'scores/Zumsteeg,_Emilie/5_Lieder/2_Der_Geburtstag/lc6158825.mscx' },
  { kind: 'lieder', id: 'lieder-zumsteeg-romanze', title: 'Romanze', composer: 'Emilie Zumsteeg', path: 'scores/Zumsteeg,_Emilie/5_Lieder/4_Romanze/lc6159273.mscx' },
  { kind: 'lieder', id: 'lieder-schroeter-an-laura', title: 'An Laura', composer: 'Corona Schröter', path: 'scores/Schröter,_Corona/25_Lieder/03_An_Laura/lc6019054.mscx' },
  { kind: 'lieder', id: 'lieder-kinkel-nachgefuehl', title: 'Nachgefühl', composer: 'Johanna Kinkel', path: 'scores/Kinkel,_Johanna/6_Lieder,_Op.10/1_Nachgefühl/lc6177220.mscx' },
  { kind: 'lieder', id: 'lieder-satie-chanson', title: 'Chanson (4 Petites mélodies)', composer: 'Erik Satie', path: 'scores/Satie,_Erik/4_Petites_mélodies/3_Chanson/lc6990810.mscx' },
  { kind: 'lieder', id: 'lieder-brahms-magdalena', title: 'Magdalena (Marienlieder, Op. 22)', composer: 'Johannes Brahms', path: 'scores/Brahms,_Johannes/Marienlieder,_Op.22/6_Magdalena/lc8702982.mscx' },
  { kind: 'lieder', id: 'lieder-zumsteeg-kapelle', title: 'Die Kapelle (Op. 4 no. 1)', composer: 'Emilie Zumsteeg', path: 'scores/Zumsteeg,_Emilie/6_Lieder,_Op.4/1_Die_Kapelle/lc6159729.mscx' },
  { kind: 'lieder', id: 'lieder-hensel-maiabend', title: 'Der Maiabend (Op. 9 no. 5)', composer: 'Fanny Hensel', path: 'scores/Hensel,_Fanny/6_Lieder,_Op.9/5_Der_Maiabend/lc5103913.mscx' },
  { kind: 'mutopia', id: 'mutopia-carcassi-op60-01', title: 'Etude 1, Op. 60', composer: 'Matteo Carcassi', dir: 'CarcassiM/O60/carcassi-op60-01', base: 'carcassi-op60-01', note: 'Classical guitar solo, original LilyPond engraving. MusicXML is a MIDI import: pitches/onsets are right, but notation details (voices, beaming, ties) are MuseScore guesses.' },
  { kind: 'mutopia', id: 'mutopia-bach-menuet-g', title: 'Menuet in G (Anna Magdalena Notebook)', composer: 'Johann Sebastian Bach (attrib.)', dir: 'BachJS/BWVAnh114/anna-magdalena-04-guitar', base: 'anna-magdalena-04-guitar', note: 'Guitar arrangement, melody over bass line, original LilyPond engraving. MusicXML is a MIDI import (see Carcassi note).' },
  { kind: 'leadsheet', id: 'greensleeves', title: 'Greensleeves', composer: 'Traditional (16th c.)', file: 'greensleeves.musicxml' },
  { kind: 'leadsheet', id: 'londonderry-air', title: 'Londonderry Air (Danny Boy)', composer: 'Traditional Irish', file: 'londonderry-air.musicxml' },
  { kind: 'leadsheet', id: 'st-louis-blues', title: 'St. Louis Blues', composer: 'W. C. Handy (1914)', file: 'st-louis-blues.musicxml' },
  { kind: 'leadsheet', id: 'after-youve-gone', title: "After You've Gone", composer: 'Creamer & Layton (1918)', file: 'after-youve-gone.musicxml' },
]

// ---------- helpers ----------

function findMscore(): string {
  const cands = [process.env.MSCORE, '/Applications/MuseScore 4.app/Contents/MacOS/mscore', '/usr/bin/mscore4', '/usr/bin/mscore']
  for (const c of cands) if (c && existsSync(c)) return c
  throw new Error('MuseScore 4 CLI not found; set MSCORE=/path/to/mscore')
}
const MSCORE = findMscore()

function run(cmd: string, args: string[]): void {
  // Do not force QT_QPA_PLATFORM=offscreen: the macOS MuseScore build only ships the cocoa plugin.
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
}

async function download(url: string, dest: string, refresh: boolean): Promise<void> {
  if (!refresh && existsSync(dest) && statSync(dest).size > 0) return
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

/** Encode 8-bit grayscale PNG (colour type 0) using the Sub filter. */
function encodeGrayPng(w: number, h: number, gray: Uint8Array): Buffer {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 1
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x]
      const left = x ? gray[y * w + x - 1] : 0
      raw[y * (w + 1) + 1 + x] = (v - left) & 255
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c
  })
  const crc = (b: Buffer) => {
    let c = -1
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Flatten (transparent -> white) and convert to grayscale PNG. */
async function normalizePng(src: string, dest: string): Promise<void> {
  const img = await loadImage(readFileSync(src))
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, img.width, img.height)
  const gray = new Uint8Array(img.width * img.height)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2])
  }
  writeFileSync(dest, encodeGrayPng(img.width, img.height, gray))
}

/** Move rendered raster pages (any "<prefix>-N.png") into page-1.png... normalized. */
async function collectPages(rawDir: string, prefix: string, outDir: string): Promise<number> {
  const files = readdirSync(rawDir)
    .map((f) => ({ f, m: f.match(new RegExp(`^${prefix}-(\\d+)\\.png$`)) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
  let n = 0
  for (const { f } of files) {
    n++
    await normalizePng(join(rawDir, f), join(outDir, `page-${n}.png`))
  }
  if (!n) throw new Error(`no pages rendered in ${rawDir}`)
  return n
}

function detectFeatures(xml: string): string[] {
  const f = new Set<string>()
  const count = (re: RegExp) => (xml.match(re) ?? []).length
  const parts = count(/<part id=/g)
  const staves = Number(xml.match(/<staves>(\d+)<\/staves>/)?.[1] ?? 1)
  if (staves >= 2) f.add('grand-staff')
  if (parts > 1) f.add('multi-part')
  if (parts === 1 && staves === 1) f.add('single-staff')
  const keys = [...new Set([...xml.matchAll(/<fifths>(-?\d+)<\/fifths>/g)].map((m) => m[1]))]
  f.add(keys.length > 1 ? 'key-change' : 'single-key')
  if (keys.some((k) => Number(k) < 0)) f.add('flat-key')
  if (keys.some((k) => Number(k) > 0)) f.add('sharp-key')
  const times = new Set([...xml.matchAll(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/g)].map((m) => `${m[1]}/${m[2]}`))
  for (const t of times) f.add(`time-${t}`)
  if (times.size > 1) f.add('time-change')
  if (/<time-modification>/.test(xml)) f.add('tuplets')
  if (/<tie /.test(xml)) f.add('ties')
  if (/<slur /.test(xml)) f.add('slurs')
  if (/<dot\/>/.test(xml)) f.add('dotted-rhythms')
  if (/<accidental>/.test(xml)) f.add('accidentals')
  if (/<lyric[ >]/.test(xml)) f.add('lyrics')
  if (/<harmony[ >]/.test(xml)) f.add('chord-symbols')
  if (/<multiple-rest>/.test(xml)) f.add('multi-measure-rest')
  if (/<slash type="start"|<notehead>slash<\/notehead>/.test(xml)) f.add('rhythm-slashes')
  if (/<rehearsal/.test(xml)) f.add('rehearsal-marks')
  if (/<dynamics/.test(xml)) f.add('dynamics')
  if (/<fermata/.test(xml)) f.add('fermata')
  if (/<accent\/>/.test(xml)) f.add('accents')
  if (/<repeat /.test(xml)) f.add('repeats')
  if (/<clef>\s*<sign>F<\/sign>/.test(xml)) f.add('bass-clef')
  return [...f]
}

// ---------- per-kind builders ----------

interface Built { source: string; sourceUrl: string; license: string; pages: number; extra?: Record<string, unknown> }

async function buildLieder(e: Extract<Entry, { kind: 'lieder' }>, outDir: string, work: string, refresh: boolean): Promise<Built> {
  const url = lieder(e.path)
  const src = join(cacheDir, 'lieder', `${e.id}.mscx`)
  await download(url, src, refresh)
  run(MSCORE, ['-o', join(outDir, 'score.musicxml'), src])
  run(MSCORE, ['-r', String(DPI), '-o', join(work, 'p.png'), src])
  const pages = await collectPages(work, 'p', outDir)
  return { source: 'OpenScore Lieder', sourceUrl: url, license: 'CC0-1.0', pages, extra: { engraving: 'MuseScore 4', groundTruth: 'MusicXML exported from the OpenScore .mscx' } }
}

async function buildMutopia(e: Extract<Entry, { kind: 'mutopia' }>, outDir: string, work: string, refresh: boolean): Promise<Built> {
  const base = `${MUTOPIA}${e.dir}/${e.base}`
  const dir = join(cacheDir, 'mutopia', e.id)
  const [pdf, mid, ly] = ['-a4.pdf', '.mid', '.ly'].map((s) => join(dir, e.base + s))
  await Promise.all([download(`${base}-a4.pdf`, pdf, refresh), download(`${base}.mid`, mid, refresh), download(`${base}.ly`, ly, refresh)])
  const lyText = readFileSync(ly, 'utf8')
  if (!/(license|copyright)\s*=\s*"Public Domain"/.test(lyText)) {
    throw new Error(`${e.id}: .ly header does not say Public Domain; refusing to redistribute`)
  }
  copyFileSync(pdf, join(outDir, 'source.pdf'))
  copyFileSync(mid, join(outDir, 'source.mid'))
  copyFileSync(ly, join(outDir, 'source.ly'))
  run(MSCORE, ['-o', join(outDir, 'score.musicxml'), mid])
  run('pdftoppm', ['-r', String(DPI), '-gray', '-png', pdf, join(work, 'p')])
  const pages = await collectPages(work, 'p', outDir)
  return {
    source: 'Mutopia Project',
    sourceUrl: `${base}.ly`,
    license: 'Public Domain',
    pages,
    extra: { engraving: 'LilyPond (original Mutopia PDF)', groundTruth: 'MIDI imported to MusicXML by MuseScore 4', note: e.note },
  }
}

async function buildLeadsheet(e: Extract<Entry, { kind: 'leadsheet' }>, outDir: string, work: string): Promise<Built> {
  const src = join(here, 'leadsheets', e.file)
  copyFileSync(src, join(outDir, 'score.musicxml'))
  run(MSCORE, ['-r', String(DPI), '-o', join(work, 'p.png'), src])
  const pages = await collectPages(work, 'p', outDir)
  return {
    source: 'TabScribe (authored; generated by scripts/omr-corpus/gen-leadsheets.mjs)',
    sourceUrl: '',
    license: 'CC0-1.0',
    pages,
    extra: { engraving: 'MuseScore 4', groundTruth: 'Authored MusicXML', melody: 'public domain (pre-1929)' },
  }
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2)
  const refresh = args.includes('--refresh')
  const ids = args.filter((a) => !a.startsWith('--'))
  const todo = ENTRIES.filter((e) => !ids.length || ids.includes(e.id))
  if (ids.length && todo.length !== ids.length) throw new Error('unknown id in ' + ids.join(','))
  mkdirSync(corpusDir, { recursive: true })
  const failures: string[] = []

  for (const e of todo) {
    const outDir = join(corpusDir, e.id)
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'omr-corpus-'))
    try {
      const b =
        e.kind === 'lieder' ? await buildLieder(e, outDir, work, refresh)
        : e.kind === 'mutopia' ? await buildMutopia(e, outDir, work, refresh)
        : await buildLeadsheet(e, outDir, work)
      const xml = readFileSync(join(outDir, 'score.musicxml'), 'utf8')
      const meta = {
        id: e.id, title: e.title, composer: e.composer,
        source: b.source, sourceUrl: e.kind === 'leadsheet' ? null : b.sourceUrl, license: b.license,
        features: detectFeatures(xml), pages: b.pages, dpi: DPI, ...b.extra,
      }
      writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
      console.log(`ok   ${e.id} (${b.pages} page${b.pages > 1 ? 's' : ''})`)
    } catch (err) {
      rmSync(outDir, { recursive: true, force: true })
      failures.push(e.id)
      console.error(`FAIL ${e.id}: ${(err as Error).message}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // manifest is always rebuilt from whatever is on disk, in ENTRIES order
  const manifest = ENTRIES.filter((e) => existsSync(join(corpusDir, e.id, 'meta.json'))).map((e) => {
    const m = JSON.parse(readFileSync(join(corpusDir, e.id, 'meta.json'), 'utf8'))
    return { id: m.id, title: m.title, composer: m.composer, source: m.source, sourceUrl: m.sourceUrl, license: m.license, features: m.features, pages: m.pages }
  })
  writeFileSync(join(corpusDir, 'manifest.json'), JSON.stringify({ generatedBy: 'scripts/omr-corpus/build-corpus.ts', dpi: DPI, entries: manifest }, null, 2) + '\n')
  if (failures.length) {
    console.error('failed: ' + failures.join(', '))
    process.exit(1)
  }
}

main()
