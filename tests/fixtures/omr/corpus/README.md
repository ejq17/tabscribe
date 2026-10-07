# OMR benchmark corpus

Redistributable page images with MusicXML ground truth, for benchmarking the OMR pipeline.
Everything here is CC0 or public domain. Regenerate with:

```
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/omr-corpus/build-corpus.ts            # all pieces
npx tsx scripts/omr-corpus/build-corpus.ts greensleeves   # selected ids
```

Needs MuseScore 4 (`MSCORE=/path/to/mscore` to override) and poppler `pdftoppm`.
Each piece directory holds `score.musicxml`, `page-N.png` (150 dpi, 8-bit grayscale, white
background), and `meta.json`. `manifest.json` lists every piece with its license and features.
`degrade.ts` is a dependency-free book-scan simulator (rotation, blur, paper tint, noise) for
robustness tests.

## Sources

- **OpenScore Lieder** (`lieder-*`): https://github.com/OpenScore/Lieder, CC0 1.0. Scores were
  encoded by OpenScore contributors from public-domain editions; credit to the OpenScore project
  and the Lieder Corpus. The `.mscx` files are fetched from a pinned commit
  (`38c5db510224d9facdc4b08d741fc788cfb58ea8`), engraved to PNG and exported to MusicXML with
  MuseScore 4. Exact URLs are in each `meta.json`.
- **Mutopia Project** (`mutopia-*`): https://www.mutopiaproject.org, pieces whose `.ly` header
  states `Public Domain` (checked by the build script). The page images are the original
  Mutopia/LilyPond PDFs rendered with `pdftoppm`; `source.pdf`, `source.mid`, `source.ly` are kept
  for provenance. MusicXML is MuseScore's import of the MIDI, so it is accurate for pitch and
  timing but not for voices, beaming or ties.
  - Etude 1, Op. 60: Matteo Carcassi, typeset by the Mutopia contributor (public domain).
  - Menuet in G (BWV Anh. 114): J. S. Bach (attrib.), typeset by Emre Akbas (public domain).
- **Lead sheets** (`greensleeves`, `londonderry-air`, `st-louis-blues`, `after-youve-gone`):
  authored for this project (CC0 1.0) by `scripts/omr-corpus/gen-leadsheets.mjs`, written to
  `scripts/omr-corpus/leadsheets/*.musicxml`. The melodies are pre-1929 public-domain tunes
  (simplified); the chord symbols and arrangement are original. They exercise jazz-chart notation:
  chord symbols (maj7, m6/bass, 7b9, m9, 13b9, 13), rehearsal marks, multi-measure rest, rhythm
  slashes, fermatas, dynamics, accents on dotted-eighth/sixteenth figures, ties across a system
  break, and key plus time changes.

Downloads are cached in the OS temp directory, not in the repo.
