// Generates the four hand-authored CC0 lead sheets (MusicXML) in ./leadsheets/.
// Run: node scripts/omr-corpus/gen-leadsheets.mjs
// The tunes are pre-1929 public-domain melodies; arrangements/chords here are original work, dedicated CC0.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'leadsheets')
mkdirSync(outDir, { recursive: true })

const DIV = 4 // divisions per quarter
const UNITS = { w: 16, h: 8, q: 4, e: 2, s: 1 }
const TYPE = { w: 'whole', h: 'half', q: 'quarter', e: 'eighth', s: '16th' }

function dur(code) {
  const dotted = code.endsWith('.')
  const b = code.replace('.', '')
  return { units: UNITS[b] * (dotted ? 1.5 : 1), type: TYPE[b], dotted }
}

const KIND = {
  '': ['major', ''],
  m: ['minor', 'm'],
  '6': ['major-sixth', '6'],
  m6: ['minor-sixth', 'm6'],
  '7': ['dominant', '7'],
  maj7: ['major-seventh', 'maj7'],
  m7: ['minor-seventh', 'm7'],
  m9: ['minor-ninth', 'm9'],
  '9': ['dominant-ninth', '9'],
  '13': ['dominant-13th', '13'],
  dim7: ['diminished-seventh', 'dim7'],
  m7b5: ['half-diminished', 'm7b5'],
}

function harmony(sym) {
  const m = sym.match(/^([A-G])([#b]?)(.*?)(?:\/([A-G][#b]?))?$/)
  if (!m) throw new Error('bad chord ' + sym)
  let [, step, acc, qual, bass] = m
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0
  const degrees = []
  const altRe = /(#|b)(5|9|11|13)/g
  let alts = qual.match(altRe) || []
  let base = qual.replace(altRe, '')
  if (!(base in KIND)) throw new Error('unknown quality ' + base + ' in ' + sym)
  for (const a of alts) {
    degrees.push({ value: Number(a.slice(1)), alter: a[0] === '#' ? 1 : -1 })
  }
  const [kind, text] = KIND[base]
  let x = `<harmony><root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>`
  x += `<kind text="${text}${alts.join('')}">${kind}</kind>`
  if (bass) {
    const bs = bass[0]
    const ba = bass[1] === '#' ? 1 : bass[1] === 'b' ? -1 : 0
    x += `<bass><bass-step>${bs}</bass-step>${ba ? `<bass-alter>${ba}</bass-alter>` : ''}</bass>`
  }
  for (const d of degrees) {
    x += `<degree><degree-value>${d.value}</degree-value><degree-alter>${d.alter}</degree-alter><degree-type>alter</degree-type></degree>`
  }
  return x + '</harmony>'
}

function noteXml(tok) {
  const [head, d, ...mods] = tok.split(':')
  const { units, type, dotted } = dur(d)
  const opt = {}
  for (const m of mods) {
    const [k, v] = m.split('=')
    opt[k] = v ?? true
  }
  let x = ''
  if (opt.dyn) {
    x += `<direction placement="below"><direction-type><dynamics><${opt.dyn}/></dynamics></direction-type></direction>`
  }
  if (opt.ch) x += harmony(opt.ch)
  x += '<note>'
  if (head === 'R') {
    x += '<rest measure="yes"/>'
  } else if (head === 'r') {
    x += '<rest/>'
  } else {
    const m = head.match(/^([A-G])([#b]?)(\d)$/)
    if (!m) throw new Error('bad pitch ' + head)
    const al = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
    x += `<pitch><step>${m[1]}</step>${al ? `<alter>${al}</alter>` : ''}<octave>${m[3]}</octave></pitch>`
  }
  x += `<duration>${units}</duration>`
  if (opt.tieend) x += '<tie type="stop"/>'
  if (opt.tie) x += '<tie type="start"/>'
  x += `<voice>1</voice>`
  if (head !== 'R') x += `<type>${type}</type>`
  if (dotted && head !== 'R') x += '<dot/>'
  if (opt.sl) x += '<notehead>slash</notehead>'
  let nt = ''
  if (opt.tieend) nt += '<tied type="stop"/>'
  if (opt.tie) nt += '<tied type="start"/>'
  if (opt.fer) nt += '<fermata type="upright"/>'
  if (opt.acc) nt += '<articulations><accent/></articulations>'
  if (nt) x += `<notations>${nt}</notations>`
  x += '</note>'
  return { xml: x, units }
}

function build(piece) {
  let cur = { fifths: piece.key, mode: piece.mode, time: piece.time }
  let out = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
<work><work-title>${piece.title}</work-title></work>
<identification>
<creator type="composer">${String(piece.composer).replace(/&/g, "&amp;")}</creator>
<rights>CC0 1.0 (arrangement and chord symbols). Melody is public domain.</rights>
<encoding><software>TabScribe corpus generator</software></encoding>
</identification>
<part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
<part id="P1">
`
  piece.measures.forEach((ms, i) => {
    out += `<measure number="${i + 1}">`
    if (ms.sys) out += '<print new-system="yes"/>'
    const keyChange = ms.key !== undefined && ms.key !== cur.fifths
    const timeChange = ms.time && (ms.time[0] !== cur.time[0] || ms.time[1] !== cur.time[1])
    if (i === 0 || keyChange || timeChange || ms.mm || ms.slash) {
      out += '<attributes>'
      if (i === 0) out += `<divisions>${DIV}</divisions>`
      if (i === 0 || keyChange) {
        if (keyChange) cur.fifths = ms.key
        if (ms.mode) cur.mode = ms.mode
        out += `<key><fifths>${cur.fifths}</fifths><mode>${cur.mode}</mode></key>`
      }
      if (i === 0 || timeChange) {
        if (timeChange) cur.time = ms.time
        out += `<time><beats>${cur.time[0]}</beats><beat-type>${cur.time[1]}</beat-type></time>`
      }
      if (i === 0) out += '<clef><sign>G</sign><line>2</line></clef>'
      if (ms.mm) out += `<measure-style><multiple-rest>${ms.mm}</multiple-rest></measure-style>`
      if (ms.slash === 'start') out += '<measure-style><slash type="start" use-stems="no"/></measure-style>'
      if (ms.slash === 'stop') out += '<measure-style><slash type="stop"/></measure-style>'
      out += '</attributes>'
    }
    if (ms.rh) {
      out += `<direction placement="above"><direction-type><rehearsal>${ms.rh}</rehearsal></direction-type></direction>`
    }
    let total = 0
    for (const tok of ms.n.trim().split(/\s+/)) {
      const r = noteXml(tok)
      out += r.xml
      total += r.units
    }
    const want = (cur.time[0] * 16) / cur.time[1]
    if (total !== want) throw new Error(`${piece.id} measure ${i + 1}: ${total} != ${want}`)
    out += '</measure>\n'
  })
  return out + '</part>\n</score-partwise>\n'
}

const pieces = [
  {
    id: 'greensleeves',
    title: 'Greensleeves',
    composer: 'Traditional (16th c.)',
    key: -2, mode: 'minor', time: [3, 4],
    measures: [
      { rh: 'A', n: 'G4:q:ch=Gm:dyn=mp Bb4:h' },
      { n: 'C5:q:ch=Bb D5:q. Bb4:e:tie' },
      { n: 'Bb4:q:tieend:ch=F A4:q. F4:e' },
      { n: 'D4:q:ch=D7b9 F4:q A4:q' },
      { n: 'G4:q:ch=Gm Bb4:h' },
      { n: 'C5:q:ch=Bb D5:q. Bb4:e' },
      { n: 'A4:q:ch=Cm9 G4:q. F#4:e' },
      { n: 'G4:h.:ch=Gm' },
      { rh: 'B', n: 'F5:q.:ch=F:acc E5:e D5:q' },
      { n: 'C5:q:ch=Ebmaj7 Bb4:q. G4:e:tie' },
      { n: 'G4:q:tieend:ch=Cm9 G4:q. F#4:e' },
      { n: 'G4:h.:ch=Gm' },
      { n: 'F5:q.:ch=F E5:e D5:q' },
      { n: 'C5:q:ch=Ebmaj7 Bb4:q. G4:e:tie' },
      { sys: true, n: 'G4:q:tieend:ch=D7b9 A4:q. F#4:e' },
      { n: 'G4:h.:ch=Gm:fer' },
    ],
  },
  {
    id: 'londonderry-air',
    title: 'Londonderry Air (Danny Boy)',
    composer: 'Traditional Irish',
    key: -3, mode: 'major', time: [4, 4],
    measures: [
      { mm: 4, n: 'R:w', slash: undefined, rh: 'Intro' },
      { n: 'R:w' },
      { n: 'R:w' },
      { n: 'R:w' },
      { rh: 'A', n: 'Bb4:q:ch=Ebmaj7:dyn=p Eb5:q:tie Eb5:q:tieend G5:q' },
      { n: 'F5:q:ch=Cm9 Eb5:q D5:q Eb5:q' },
      { n: 'G5:q.:ch=Fm7 Bb5:e Bb5:h' },
      { n: 'Ab5:q:ch=Bb13 G5:q F5:q Eb5:q' },
      { n: 'Eb5:h:ch=Ebmaj7 D5:q C5:q' },
      { n: 'Bb4:q:ch=Abm6 C5:q Eb5:h:tie' },
      { n: 'Eb5:q:tieend:ch=Ebmaj7/G D5:q C5:h' },
      { n: 'Bb4:w:ch=Bb13:fer' },
      { rh: 'B', n: 'Bb4:q:ch=Ebmaj7:dyn=mf Eb5:q Eb5:q G5:q' },
      { n: 'F5:q:ch=Cm9 Eb5:q D5:q Eb5:q' },
      { n: 'G5:q.:ch=Fm7 Bb5:e Bb5:h' },
      { n: 'Ab5:q:ch=Bb13 G5:q F5:q Eb5:q:tie' },
      { sys: true, n: 'Eb5:h:tieend:ch=Ebmaj7 D5:q C5:q' },
      { n: 'Bb4:h:ch=Ab6 C5:h' },
      { slash: 'start', n: 'Bb4:q:sl:ch=Ebmaj7 Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { slash: 'stop', n: 'Bb4:q:sl:ch=Bb13 Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { n: 'Eb5:w:ch=Ebmaj7:fer' },
    ],
  },
  {
    id: 'st-louis-blues',
    title: 'St. Louis Blues',
    composer: 'W. C. Handy (1914)',
    key: -2, mode: 'minor', time: [4, 4],
    measures: [
      { rh: 'A', n: 'r:q G4:e.:acc:ch=Gm7:dyn=mf Bb4:s D5:q D5:e. C5:s' },
      { n: 'Bb4:q:ch=Cm9 G4:e. Bb4:s:acc D5:h' },
      { n: 'r:q G4:e.:ch=Gm7 Bb4:s D5:q D5:e. C5:s' },
      { n: 'Bb4:q:ch=D7b9 A4:e. G4:s:acc F#4:h' },
      { n: 'G4:q:ch=Cm9 Bb4:q C5:q:acc D5:q' },
      { n: 'Eb5:h:ch=Ebm6/F D5:q C5:q' },
      { n: 'Bb4:q:ch=Gm7 A4:q G4:q F#4:q' },
      { n: 'G4:h:ch=G13b9 r:h' },
      { rh: 'B', key: -3, mode: 'minor', time: [2, 4], n: 'C5:e.:acc:ch=Cm9:dyn=f D5:s Eb5:q' },
      { n: 'G5:q:ch=Fm7 F5:q' },
      { n: 'Eb5:e.:acc:ch=Bb13 D5:s C5:q' },
      { n: 'Bb4:h:ch=Cm9' },
      { rh: 'C', key: -2, mode: 'minor', time: [4, 4], n: 'G4:q:ch=Gm7:dyn=mp Bb4:q D5:q G5:q' },
      { n: 'F5:e.:acc:ch=D7b9 Eb5:s D5:q C5:h' },
      { n: 'Bb4:q:ch=Cm9 A4:q G4:q F#4:q' },
      { n: 'G4:w:ch=Gm7:fer' },
    ],
  },
  {
    id: 'after-youve-gone',
    title: "After You've Gone",
    composer: 'Creamer & Layton (1918)',
    key: -2, mode: 'major', time: [4, 4],
    measures: [
      { rh: 'A', n: 'D5:q:ch=Bbmaj7:dyn=mf Bb4:q D5:q F5:q' },
      { n: 'F5:h:ch=Ebm6/F D5:q C5:q' },
      { n: 'Bb4:q:ch=Cm9 C5:q D5:q Eb5:q' },
      { n: 'D5:h:ch=D7b9 r:h' },
      { n: 'D5:q:ch=G13b9 Eb5:e. D5:s C5:q Bb4:q' },
      { n: 'A4:h:ch=Cm9 F4:h' },
      { n: 'G4:q:ch=Bbmaj7/F A4:q Bb4:q C5:q' },
      { n: 'Bb4:h:ch=Bbmaj7 r:h' },
      { rh: 'B', slash: 'start', n: 'Bb4:q:sl:ch=Bbmaj7 Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { n: 'Bb4:q:sl:ch=Ebm6/F Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { n: 'Bb4:q:sl:ch=Cm9 Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { slash: 'stop', n: 'Bb4:q:sl:ch=D7b9 Bb4:q:sl Bb4:q:sl Bb4:q:sl' },
      { n: 'D5:q:acc:ch=G13b9 Eb5:e. D5:s C5:q Bb4:q' },
      { n: 'A4:q:ch=Cm9 Bb4:q C5:q D5:q' },
      { n: 'Bb4:q:ch=Bbmaj7 A4:q Bb4:h' },
      { n: 'Bb4:w:ch=Bbmaj7:fer' },
    ],
  },
]

for (const p of pieces) {
  writeFileSync(join(outDir, `${p.id}.musicxml`), build(p))
  console.log('wrote', p.id)
}
