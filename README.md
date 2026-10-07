# TabScribe

Turn sheet music, MIDI, MusicXML, ABC, Guitar Pro files and audio recordings into editable guitar tablature,
with chord names and diagrams, playback with sampled acoustic guitar, and export to MIDI, MusicXML and ASCII tab.
Runs entirely in the browser and works offline after the first visit (installable PWA).

Live: https://ejq17.github.io/tabscribe/

## Supported inputs

| Input | How | Accuracy |
|---|---|---|
| PDF / PNG / JPG sheet music | In-browser optical music recognition | Best effort on clean printed scores. Fix mistakes in the editor. |
| MIDI (.mid) | Exact | Exact pitches and timing |
| MusicXML (.xml, .musicxml, .mxl) | Exact | Exact, keeps string/fret if present |
| Guitar Pro (.gp3, .gp4, .gp5, .gpx, .gp) | Exact | Keeps the file's fingering |
| ABC notation (.abc) | Exact | Exact |
| Audio (.mp3, .wav, .m4a, .ogg) | Monophonic pitch detection | Single-note melodies only |

## Editing

Click a note to select it. Arrow keys change pitch, digits set the fret, `S` moves the note to another string,
`L` locks a fingering, Delete removes, Cmd/Ctrl+Z undoes. Enter opens the full note editor. Low-confidence
notes from OMR or audio are shown in amber, and the original page is shown alongside so you can check them.

## Develop

Requires Node 22.

```
npm install
npm run dev
npm test
npm run build
```

Deploys to GitHub Pages automatically from `main` via GitHub Actions.

## Sheet-music import settings

- **Sheet music is written for guitar (sounds an octave lower)** (Settings > Analysis, on by default, saved with your other
  preferences). Guitar parts are printed an octave above their sounding pitch, so scanned treble clefs are read an octave
  lower. Turn it off when importing piano, vocal or other concert-pitch scores. A printed "8" under a treble clef is
  detected automatically either way.
- **Chord symbols** printed above the staff are read with OCR (tesseract.js), which is lazy-loaded from a CDN the first
  time a scanned score is imported. To work offline, bundle the engine yourself and call `configureChordOcr` (exported
  from `src/omr`) with local worker/core/language paths before importing.

## OMR benchmark

`scripts/omr-bench/` measures how well the scanner reads sheet music. Run with Node 22 and `npx tsx`.

- `run.ts <file.pdf> [--scale 2.5] [--out DIR] [--json] [--instrument guitar|concert]` renders a PDF, runs the
  recognizer and dumps per-measure results (default `concert`, so charts with written-pitch ground truth score correctly).
- `corpus-bench.ts [--ids a,b] [--out DIR]` runs the whole corpus (clean and degraded scans) and prints pitch, rhythm,
  key/time, measure and chord metrics. Pieces whose `meta.json` has `"instrument": "guitar"` are read with the guitar
  octave shift.
- The corpus lives in `tests/fixtures/omr/corpus/` (one folder per piece: page image, `score.musicxml` ground truth,
  `meta.json`). Sources are CC0 / public-domain scores (OpenScore Lieder, Mutopia, traditional tunes); each piece's licence
  is recorded in `manifest.json` and the folder's `meta.json`.
- Put copyrighted charts you own in the git-ignored `tests/fixtures/omr/real-local/` folder to benchmark them
  locally without committing them.
- Rebuild the corpus with `npx tsx scripts/omr-corpus/build-corpus.ts`. This needs MuseScore 4 installed to render the
  pages from the MusicXML.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Every importer produces a `Score`; the tab engine, chord
detector, renderer, player and exporters all consume it.

## Licenses

Code: MIT. Guitar samples: FluidR3_GM via gleitz/midi-js-soundfonts (MIT), see `public/samples/LICENSE.txt`.
