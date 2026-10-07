# TabScribe — Architecture & Module Contracts

TabScribe is a fully static, offline-capable web app (React + TypeScript + Vite, PWA) deployed to GitHub Pages at
`https://ejq17.github.io/tabscribe/`. It converts sheet music (PDF/images via OMR), MIDI, MusicXML, ABC, Guitar Pro
and audio into editable guitar tablature with chord names and diagrams, plays the tab back with sampled guitar,
and exports MIDI / MusicXML / ASCII tab.

**Non-negotiable rules for every module**

1. The ONLY shared data model is `src/core/score.ts` (`Score`, `Track`, `Note`, …). Importers produce a `Score`;
   everything else consumes one. Never add importer-specific fields to `Note`; use `Score.meta`.
2. Pitch = MIDI number. Time = ticks with `score.ppq` (default 480). String 0 = highest string.
3. Pure modules (`core`, `importers`, `tab`, `chords`, `export`, `omr` algorithms) must not import React or touch
   the DOM except where explicitly noted (pdf.js rendering, Web Audio). Keep them testable under vitest/jsdom.
4. No network calls at runtime. Everything must work offline after first load. Assets live in `public/`.
5. Vite `base` is `/tabscribe/`. Use `import.meta.env.BASE_URL` for asset URLs.
6. TypeScript strict; `npm run build` must pass with zero errors. `npm test` (vitest) must pass.
7. Each module exports exactly the signatures below from its `index.ts`. Add more exports freely, but keep these.

## Module contracts

### `src/importers`
```ts
importMidi(data: ArrayBuffer): Score                       // via @tonejs/midi
importMusicXml(data: ArrayBuffer | string): Score          // .xml/.musicxml and compressed .mxl (fflate unzip)
importAbc(text: string): Score                             // via abcjs parseOnly, or own parser
importGuitarPro(data: ArrayBuffer, filename: string): Score // .gp3/.gp4/.gp5 binary, .gpx and .gp (zip + XML)
importFile(file: File, opts?: ImportOptions): Promise<Score> // dispatcher; routes pdf/png/jpg → omr, mp3/wav/m4a/ogg → audio
interface ImportOptions { onProgress?: (p: { stage: string; fraction: number }) => void }
```
Guitar Pro importers must set `note.tab` and `tabLocked = true` for every note (the file already has fingering).
MusicXML with `<technical><string>/<fret>` likewise. Set `meta.source`, `meta.title`, `meta.warnings`.

### `src/omr`
```ts
renderPdfPages(data: ArrayBuffer, scale?: number): Promise<HTMLCanvasElement[]>   // pdfjs-dist, worker bundled locally
imageToCanvas(file: Blob): Promise<HTMLCanvasElement>
recognizeScore(pages: HTMLCanvasElement[], opts?: OmrOptions): Promise<Score>
interface OmrOptions { onProgress?: (p: { stage: string; fraction: number; page?: number }) => void; defaultClef?: 'treble' | 'bass' }
```
`recognizeScore` must: binarize, detect staves (5 equally spaced lines) by horizontal projection, estimate
staff-space, remove staff lines, find noteheads (filled & hollow) via connected components / template matching,
map vertical position to pitch using the detected or default clef and key signature, estimate durations from
notehead type + stems/flags/beams (best-effort, default quarter), detect barlines, and emit a `Score` with
`note.confidence` set and `meta.sourcePages` = data URLs of each page. Heavy work runs in a Web Worker if the
work exceeds ~200ms per page. Accuracy is best effort; the editor fixes the rest.

### `src/audio`
```ts
transcribeAudio(data: ArrayBuffer, opts?: AudioTranscribeOptions): Promise<Score> // decode via OfflineAudioContext, pitch via pitchy (McLeod), onset segmentation, quantize to 16ths at estimated tempo
class Player {
  constructor()
  load(): Promise<void>                       // loads bundled samples from `${BASE_URL}samples/…`
  play(score: Score, guitar: GuitarConfig, opts?: { fromTick?: number; tempoScale?: number; onTick?: (tick: number) => void; onEnd?: () => void; metronome?: boolean }): void
  pause(): void; resume(): void; stop(): void; seek(tick: number): void
  playNote(pitch: number, durationSec?: number): void   // for editor auditioning
  readonly isPlaying: boolean
}
```
Samples: bundle steel-string acoustic guitar mp3 samples (one per semitone or every 3 semitones, pitch-shifted
via playbackRate) under `public/samples/`. Source: gleitz/midi-js-soundfonts FluidR3_GM `acoustic_guitar_steel-mp3`
(MIT). Keep total under ~3 MB. Add a `public/samples/LICENSE.txt`.

### `src/tab`
```ts
assignTab(score: Score, guitar: GuitarConfig): Score   // returns a NEW score with note.tab set for the guitar track; never changes notes with tabLocked
toAsciiTab(score: Score, guitar: GuitarConfig, opts?: { measuresPerLine?: number; chords?: ChordEvent[] }): string
```
Algorithm: group notes into simultaneous "chord slices" by start tick; for each slice enumerate playable
string/fret combos (distinct strings, fret span ≤ 5 excluding open strings, respect maxFret and capo);
dynamic programming across slices minimizing: fret-position movement, span, high frets, string skipping,
with a bonus for open strings and for staying in position. Notes outside the guitar range are transposed by
octaves until playable and get `meta.warnings` entries. Must handle polyphony up to 6 notes.

### `src/chords`
```ts
interface ChordEvent { tick: number; duration: number; name: string; root: number; quality: string; bass?: number; pitches: number[] }
detectChords(score: Score, opts?: { resolution?: 'beat' | 'measure' | 'half' }): ChordEvent[]
interface ChordDiagram { name: string; frets: (number | -1)[] /* per string, 0=open, -1=mute, string 0 = high */; fingers?: number[]; baseFret: number; barres?: { fret: number; from: number; to: number }[] }
chordDiagram(name: string, tuning: Tuning): ChordDiagram | null      // library of common shapes for standard tuning + computed fallback for any tuning
diagramFromVoicing(notes: TabPosition[], name: string): ChordDiagram
strumChart(score: Score, chords: ChordEvent[]): StrumLine[]           // simplified: one line per measure group with chord symbols at beat positions
```
Chord detection: pitch-class template matching (maj, min, dim, aug, 7, maj7, m7, m7b5, dim7, sus2, sus4, add9,
6, m6, 9, power chord) with weighting by duration & bass note; merge identical adjacent chords.

### `src/export`
```ts
exportMidi(score: Score): Uint8Array           // @tonejs/midi; honors tempos, time sigs, programs; guitar track program 25 (steel)
exportMusicXml(score: Score, guitar: GuitarConfig): string   // part-wise, includes <technical><string><fret> from note.tab
downloadBlob(data: BlobPart, filename: string, mime: string): void
```

### `src/store` (zustand)
State: `score`, `guitar`, `chords`, `selection` (note ids), `playback` {isPlaying, tick, tempoScale}, `view`
{showNotation, showChords, showDiagrams, showSource, mode: 'tab' | 'strum'}, `history` (undo/redo stacks of
scores, cap 100). Actions: `loadScore`, `setGuitar` (re-runs assignTab), `updateNote(id, patch)`,
`addNote`, `deleteNotes`, `moveNoteToString(id, string)`, `transposeSelection`, `undo`, `redo`,
`reassignTab`, `setCapo`. Every mutation that changes notes re-runs `assignTab` (respecting locks) and
`detectChords`.

### `src/ui`
React components. The editable tab is a custom SVG renderer (we own click targets); standard notation
view uses VexFlow (read-only, optional toggle). Required UX:
- Drag & drop / file picker for all supported types; progress UI with stage text.
- Tab view: measures wrap across lines, numbers on strings, durations shown as stems below the tab, chord
  names above, optional chord diagrams row. Click a note to select; keyboard: ↑/↓ semitone, Shift+↑/↓ octave,
  ←/→ move selection, Delete, Ctrl/Cmd+Z / Shift+Z undo/redo, number keys set fret, `S` cycle string,
  Enter opens a popover editor (pitch name, fret, string, duration, lock). Double-click an empty beat to add a note.
- Source pane: shows original PDF/image page alongside (for OMR) and highlights low-confidence notes in amber.
- Transport: play/pause/stop, position slider, tempo %, loop selection, metronome, playhead follows notes.
- Settings: tuning select (+ custom tuning editor), capo, max fret, reassign button.
- Export menu: MIDI, MusicXML, ASCII tab (.txt), print (CSS print stylesheet).
- Strum-chart mode.
- Works on phone width. Dark/light follows system.

## Directory layout
```
src/core        score model, theory
src/importers   midi, musicxml, abc, guitarpro, index (dispatcher)
src/omr         pdf, image, staff detection, symbols, worker, index
src/audio       transcribe, player, samples loader
src/tab         engine, ascii
src/chords      detect, shapes, strum
src/export      midi, musicxml, download
src/store       zustand store + history
src/ui          React components
tests           vitest unit tests (fixtures under tests/fixtures)
public/samples  guitar samples
```
