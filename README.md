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

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Every importer produces a `Score`; the tab engine, chord
detector, renderer, player and exporters all consume it.

## Licenses

Code: MIT. Guitar samples: FluidR3_GM via gleitz/midi-js-soundfonts (MIT), see `public/samples/LICENSE.txt`.
