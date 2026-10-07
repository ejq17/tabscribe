# OMR error catalogue: "A Child Is Born" (guitar part, 4-page PDF)

Generated with the Node harness in this folder. Nothing under `src/omr` was modified.

## How to reproduce

```
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/omr-bench/run.ts tests/fixtures/omr/real-local/a-child-is-born-guitar.pdf [--scale 2.5] [--out DIR]
npx tsx scripts/omr-bench/score-a-child-is-born.ts <OUT>/a-child-is-born-guitar.json     # scores against hand-read truth
```

`run.ts` renders with pdf.js (legacy build, `disableWorker`) onto a `@napi-rs/canvas` canvas at scale 2.5 (same 1530x1980 pages as the browser path), saves PNGs, calls `analyzePage` + `assembleScore` (the two halves of `recognizeImageData`, so per-staff symbols can be dumped), and prints a per-page symbol summary, a per-system positional measure map, a per-measure note dump and `meta.warnings`. Harness reliability: pdf.js in Node worked first time, ~4 s for the whole file, deterministic. Rests are not in the Score, so the per-staff rest counts come from `PageResult.symbols`. Output PNGs: `/private/tmp/claude-501/-Users-ejquigley-Documents-Projects-Sheet-Music-to-Guitar-Tabs/5ecd0d2c-4e15-4b1e-94a8-3cd0301c1a16/scratchpad/bench/`.

## Ground truth used (and corrections to the brief)

I re-read the PDF at 200 dpi. The brief's truth was right in structure but wrong on a few pitches, so the scorer uses what is printed:
- m120/122/124/128/130/131-pattern bars are Ab4 Bb4 **Eb5** (not C5); m132 is A-natural Bb4 Eb5.
- m125 is G5 dotted half, m126 F5, m133 G5 (not Eb5/Db5/Eb5); m158 is G4 B4 **D5**; m159 G5, m160 F5, m161 E5 (not B4).
- m53 is D5 dotted-quarter, B-natural eighth, B quarter (tie is inside the bar); m54 B-natural half + quarter rest.
- m48/50/52 contain dotted-quarter / quarter figures, not dotted-eighth/sixteenth.
- Page 3 key/time change at m119 is printed as a courtesy at the END of system 2 (after the double barline), and again with the clef at the start of system 3. Same for the m83 change at the end of p2 system 5.
Expected single-line melody notes scored: **83** (not ~60). The m162 rolled chord is scored separately.

## Accuracy summary

| run | pitch correct | pitch + onset | pitch + onset + duration |
|---|---|---|---|
| Baseline (unmodified src/omr) | 46/83 (55%) | 23/83 | 7/83 (8%) |
| Experiment: one constant changed in a scratch copy (see class 1) | 75/83 (90%) | 35/83 | 8/83 (10%) |

Baseline emitted 87 notes: 79 melody notes plus 8 in the m162 chord. 33 of the 79 matched no expected note by pitch (mostly flat/natural errors); none were emitted in bars that should be empty. No spurious notes came from chord symbols, dynamics, accents/marcato, slash bars, fermatas or text. Page 4 (chord diagrams) correctly produced "Page 4: no staves found." and no notes.

Positional measure numbering drifts (see class 6); the table maps pipeline cells to printed measure numbers by hand (offset table in the scorer). Start/duration are in quarter-note beats from the printed bar start; "?" low-confidence flags omitted.

### Per-measure, baseline (expected vs got)

| m | expected | got | pitch ok | + start ok | + dur ok |
|---|---|---|---|---|---|
| 1 | D4@0x3 | D4@0.5x2 | 1/1 | 0/1 | 0/1 |
| 2 | Eb4@0x1 F4@1x1 Bb4@2x1 | E4@0x1.5 F4@1.5x1.25 B4@2.75x1.25 | 1/3 | 0/3 | 0/3 |
| 3 | F4@0x0.5 G4@0.5x0.5 A4@1x0.5 Bb4@1.5x0.5 C5@2x0.5 D5@2.5x0.5 | F4@0x0.5 G4@0.5x0.5 A4@1x0.75 B4@1.75x0.75 C5@2.5x0.75 D5@3.25x0.75 | 5/6 | 3/6 | 2/6 |
| 4 | F5@0x2 Eb5@2x1 | E5@0x1 | 0/2 | 0/2 | 0/2 |
| 5 | Bb4@1x0.5 C5@1.5x0.5 Bb4@2x0.5 C5@2.5x0.5 | B4@0x1 C5@1x1 B4@2x1 C5@3x1 | 2/4 | 0/4 | 0/4 |
| 6 | D5@0x0.5 Eb5@0.5x0.5 D5@1x0.5 Eb5@1.5x0.5 F5@2x0.5 E5@2.5x0.5 | D5@0.33x0.33 E5@0.67x0.33 D5@1x0.5 E5@1.5x0.5 F5@2x0.5 Eb5@3.5x0.5 | 5/6 | 2/6 | 2/6 |
| 7 | Eb5@0x1 D5@1x1 C5@2x1 | E5@0x1.5 D5@1.5x1.25 C5@2.75x1.25 | 2/3 | 0/3 | 0/3 |
| 8 | D5@0x3 | D5@0x4 | 1/1 | 1/1 | 0/1 |
| 46 | G4@1x0.5 A4@1.5x0.5 Bb4@2x0.5 C5@2.5x0.5 | G4@0x1 A4@1x1 B4@2x1 C5@3x1 | 3/4 | 0/4 | 0/4 |
| 47 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 48 | F5@0.5x1.5 D5@2x1 | F5@0.5x1.5 D5@2x2 | 2/2 | 2/2 | 1/2 |
| 49 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 50 | F5@0.5x1.5 Eb5@2x1 | F5@0.5x1.5 E5@2x2 | 1/2 | 1/2 | 1/2 |
| 51 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 52 | G4@0.5x1 Bb4@1.5x1 C5@2.5x0.5 | G4@0.75x1.25 B4@2x1.25 C5@3.25x0.75 | 2/3 | 0/3 | 0/3 |
| 53 | D5@0x1.5 B4@1.5x0.5 B4@2x1 | D5@0x1.5 Bb4@1.5x0.5 Bb4@2x2 | 1/3 | 1/3 | 1/3 |
| 54 | B4@0x2 | B4@0.75x3.25 | 1/1 | 0/1 | 0/1 |
| 119 | G4@0x3 | - | 0/1 | 0/1 | 0/1 |
| 120 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | A4@0x1.5 B4@1.5x1.25 E5@2.75x1.25 | 0/3 | 0/3 | 0/3 |
| 121 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 122 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | A4@0x1.5 B4@1.5x1.25 E5@2.75x1.25 | 0/3 | 0/3 | 0/3 |
| 123 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 124 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | A4@0.5x1 B4@1.5x1.25 E5@2.75x1.25 | 0/3 | 0/3 | 0/3 |
| 125 | G5@0x3 | - | 0/1 | 0/1 | 0/1 |
| 126 | F5@0x3 | F5@0x4 | 1/1 | 1/1 | 0/1 |
| 127 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 128 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | A4@0x1.5 B4@1.5x1.25 E5@2.75x1.25 | 0/3 | 0/3 | 0/3 |
| 129 | G4@0x3 | G4@1x3 | 1/1 | 0/1 | 0/1 |
| 130 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | A4@0x1.5 B4@1.5x1.25 E5@2.75x1.25 | 0/3 | 0/3 | 0/3 |
| 131 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 132 | A4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@1.25x0.75 B4@2x1 E5@3x1 | 0/3 | 0/3 | 0/3 |
| 133 | G5@0x3 | G5@0x4 | 1/1 | 1/1 | 0/1 |
| 134 | Bb4@0x2 Ab4@2x1 | B4@0.5x2.25 A4@2.75x1.25 | 0/2 | 0/2 | 0/2 |
| 157 | E4@0x3 | E4@0x4 | 1/1 | 1/1 | 0/1 |
| 158 | G4@0x1 B4@1x1 D5@2x1 | G4@0x1.5 B4@1.5x1.25 D5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 159 | G5@0x3 | G5@0x4 | 1/1 | 1/1 | 0/1 |
| 160 | F5@0x3 | F5@0x4 | 1/1 | 1/1 | 0/1 |
| 161 | E5@0x3 | - | 0/1 | 0/1 | 0/1 |

### Per-measure, with the clef-stroke experiment applied (scratch copy only)

| m | expected | got | pitch ok | + start ok | + dur ok |
|---|---|---|---|---|---|
| 1 | D4@0x3 | D4@0.5x2 | 1/1 | 0/1 | 0/1 |
| 2 | Eb4@0x1 F4@1x1 Bb4@2x1 | Eb4@0x1.5 F4@1.5x1.25 Bb4@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 3 | F4@0x0.5 G4@0.5x0.5 A4@1x0.5 Bb4@1.5x0.5 C5@2x0.5 D5@2.5x0.5 | F4@0x0.5 G4@0.5x0.5 A4@1x0.75 Bb4@1.75x0.75 C5@2.5x0.75 D5@3.25x0.75 | 6/6 | 3/6 | 2/6 |
| 4 | F5@0x2 Eb5@2x1 | Eb5@0x1 | 1/2 | 0/2 | 0/2 |
| 5 | Bb4@1x0.5 C5@1.5x0.5 Bb4@2x0.5 C5@2.5x0.5 | Bb4@0x1 C5@1x1 Bb4@2x1 C5@3x1 | 4/4 | 1/4 | 0/4 |
| 6 | D5@0x0.5 Eb5@0.5x0.5 D5@1x0.5 Eb5@1.5x0.5 F5@2x0.5 E5@2.5x0.5 | D5@0.33x0.33 Eb5@0.67x0.33 D5@1x0.5 Eb5@1.5x0.5 F5@2x0.5 Eb5@3.5x0.5 | 5/6 | 3/6 | 3/6 |
| 7 | Eb5@0x1 D5@1x1 C5@2x1 | Eb5@0x1.5 D5@1.5x1.25 C5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 8 | D5@0x3 | D5@0x4 | 1/1 | 1/1 | 0/1 |
| 46 | G4@1x0.5 A4@1.5x0.5 Bb4@2x0.5 C5@2.5x0.5 | G4@0x1 A4@1x1 Bb4@2x1 C5@3x1 | 4/4 | 1/4 | 0/4 |
| 47 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 48 | F5@0.5x1.5 D5@2x1 | F5@0.5x1.5 D5@2x2 | 2/2 | 2/2 | 1/2 |
| 49 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 50 | F5@0.5x1.5 Eb5@2x1 | F5@0.5x1.5 Eb5@2x2 | 2/2 | 2/2 | 1/2 |
| 51 | D5@0x1.5 D5@1.5x0.5 | D5@0x3 D5@3x1 | 2/2 | 1/2 | 0/2 |
| 52 | G4@0.5x1 Bb4@1.5x1 C5@2.5x0.5 | G4@0.75x1.25 Bb4@2x1.25 C5@3.25x0.75 | 3/3 | 0/3 | 0/3 |
| 53 | D5@0x1.5 B4@1.5x0.5 B4@2x1 | D5@0x1.5 Bb4@1.5x0.5 Bb4@2x2 | 1/3 | 1/3 | 1/3 |
| 54 | B4@0x2 | B4@0.75x3.25 | 1/1 | 0/1 | 0/1 |
| 119 | G4@0x3 | - | 0/1 | 0/1 | 0/1 |
| 120 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@0x1.5 Bb4@1.5x1.25 Eb5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 121 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 122 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@0x1.5 Bb4@1.5x1.25 Eb5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 123 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 124 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@0x1.5 Bb4@1.5x1.25 Eb5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 125 | G5@0x3 | - | 0/1 | 0/1 | 0/1 |
| 126 | F5@0x3 | F5@0x4 | 1/1 | 1/1 | 0/1 |
| 127 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 128 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@0x1.5 Bb4@1.5x1.25 Eb5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 129 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 130 | Ab4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@0x1.5 Bb4@1.5x1.25 Eb5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 131 | G4@0x3 | G4@0x4 | 1/1 | 1/1 | 0/1 |
| 132 | A4@0x1 Bb4@1x1 Eb5@2x1 | Ab4@1.25x0.75 Bb4@2x1 Eb5@3x1 | 2/3 | 0/3 | 0/3 |
| 133 | G5@0x3 | G5@0x4 | 1/1 | 1/1 | 0/1 |
| 134 | Bb4@0x2 Ab4@2x1 | Bb4@0.5x2.25 Ab4@2.75x1.25 | 2/2 | 0/2 | 0/2 |
| 157 | E4@0x3 | E4@0x4 | 1/1 | 1/1 | 0/1 |
| 158 | G4@0x1 B4@1x1 D5@2x1 | G4@0x1.5 B4@1.5x1.25 D5@2.75x1.25 | 3/3 | 1/3 | 0/3 |
| 159 | G5@0x3 | G5@0x4 | 1/1 | 1/1 | 0/1 |
| 160 | F5@0x3 | F5@0x4 | 1/1 | 1/1 | 0/1 |
| 161 | E5@0x3 | - | 0/1 | 0/1 | 0/1 |

## Failure classes, ranked by impact

### 1. Treble clef is never recognized, so the key signature is never read (ROOT CAUSE for most pitch errors)
- Every one of the 29 staves reports `clefDetected=false`; key = 0 everywhere (should be -2 on p1-p2 sys1-5, 0 at m83, -3 at m119-134, 0 from m135). Result: every Eb/Bb/Ab is a natural (Eb4->E4, Bb4->B4, Ab4->A4, Eb5->E5 ...), plus a "no clef was found" warning on each page.
- Diagnosis (measured, with debug prints in a scratch copy): the clef zone is found correctly (x 4..44, 8.1 staff spaces tall) but `findStrokes` returns nothing, because the clef's long vertical axis, after staff-line removal, only has unbroken runs of about 30 px = 2.4 d, while the check demands 4.0 d. `src/omr/symbols.ts:690` (`findStrokes(..., Math.round(4.0 * d), ...)`) and the acceptance test at `symbols.ts:691`. With the clef rejected, `clefEnd` stays at the staff left edge and `readKeySignature` (`src/omr/glyphs.ts:356`) starts inside the clef glyph and reads 0.
- Verified: changing 4.0 to 2.4 at `symbols.ts:690` (in a scratch copy, not committed) makes all 29 clefs detected and gives key -2, -2, ..., 0 (m83), -3 (m119-134), 0 (m135+). Pitch accuracy goes 55% -> 90%. Mid-system key courtesies after a double barline are still not used (see class 4). This clef font is a Lilypond/Emmentaler-style glyph; the synthetic test fixtures presumably have a straighter stem.

### 2. Time signature never read, everything is measured in 4/4 (ROOT CAUSE for most rhythm errors)
- No staff reports a time signature in 3/4. Assembler falls back to 4/4 (`assemble.ts:~188-200`, `curTs = {4,4}`), so every 3-beat bar is "repaired"/rescaled to 4 beats by `layoutMeasure` (`rhythm.ts:~162-239`, rescale factor 0.5-2.0 path): 3 quarters become 1.5/1.25/1.25, eighths become 0.75, a 3-beat dotted half becomes 4 beats. 35 measures warned "did not add up". Only 8/83 notes get both onset and duration right.
- Diagnosis: with the clef fix, the digits sit at keyEnd..+3.4 d, but the bold "3" over "4" is labelled as ONE connected component (x 91..111, y 69..119, i.e. 4 staff spaces tall; staff-line removal leaves the middle-line fragment joining them). `digitLike` (`symbols.ts:751`) requires height 1.2-2.6 d, so the stacked pair is rejected and no stack is found; leftover fragments (e.g. a 5x7 px piece at x 72..77) are then treated as rest/dot junk. Fix idea: split tall (3.2-4.8 d) components at `midL` before the digit test.
- Side effect: the leftover time-sig fragment is read as an eighth rest at the start of m1, which shifts the first note: D4 comes out at beat 0.5 x 2 instead of beat 0 x 3.
- Common time at m83 is read as **2/2** (cut time): `symbols.ts:795` (`maxVRunFrac >= 0.93` => cut time). The plain C glyph's vertical-run fraction exceeds the threshold after line removal. (Seen with the clef fix applied; in the baseline m83 sees no time signature at all.)

### 3. Natural signs are never applied
- m6 last note should be E-natural (baseline gives Eb5 even though no key is set), m53 B-natural gives Bb4 with the key fix, m54 B-natural half, m132 A-natural gives Ab4, and the key-change naturals (m135) are not recognized. `pitch.ts:46-48` handles `accidental === 'natural'` correctly, so the natural is never attached to the head: `classifyAccidental` (`symbols.ts:289-298`) and the two-vertical natural finder (`accidentals.ts:58`) do not fire on these small naturals (about 1.3 d tall in this engraving).

### 4. Key/time changes at the END of a staff (courtesy after a double barline) are ignored or create phantom measures
- m83 (p2 sys5 end: naturals + C) and m119 (p3 sys2 end: 3 flats + 3/4): the symbol reader only reads the prefix at the left of each staff, so the 3/4 for m119+ never reaches the assembler (it is only printed at the end of sys2, not at the start of sys3). Key is partly rescued by the per-system vote in `assemble.ts:165-171`.
- The same trailing junk creates a phantom measure: p2 sys5 and p3 sys2 each report 6 cells for 5 bars, because `staffMeasures` `closed` test (`rhythm.ts:~133`, `barlines[nb-1] >= right - 2.5*d`) fails when the last barline is a double bar followed by the new signature, so the leftover rest-like fragments make a 6th slot.

### 5. Rests: quarter rests read as eighth rests, half/whole nearly absent; slash bars read as eighth rests
- Every rest in the file comes out as `eighth` (one `quarter.` on p3), including m5, m46, m47, m49, m51 quarter rests. Rule: `symbols.ts:1459` (`kind = h >= 2.55*d ? 'quarter' : 'eighth'`); the quarter rest here is shorter than 2.55 d. Dropped/misclassified rests are why m46 "G4 A4 Bb4 C5" comes out as four 1-beat quarters instead of four eighths after a quarter rest, and why m47/49/51 D5 dotted-quarter + eighth come out as 3 + 1 beats.
- On slash-heavy staves 15-20 spurious `eighth` rests per staff (p2 sys1, sys2, sys5-8, p3 sys1-2) come from the diagonal slash strokes or chord-symbol text when `slashes=0` (slash detection only fired on about 35 of ~150 slashes; requires slope 18-75 deg, `symbols.ts:~872`). Harmless today since slash-only bars emit no notes, but any real note in such a bar would be mis-timed.

### 6. Multi-measure rest count misread, measure numbering drifts
- The "4" over the 4-bar rest (m9-12 and m153-156) is read as **3** by `classifyDigit` (`symbols.ts:315`, called at `symbols.ts:910`), with `guessed=false`, so no warning. Drift: pipeline total is 162 only by coincidence (two -1 errors from the rests, offset by two +1 phantom cells from class 4). Between the first rest and p2 sys6 positional numbers are off by +1; p3 sys3-sys9 are off by -1. Any downstream feature that maps pipeline bars to printed bar numbers is wrong mid-piece.

### 7. Hollow (half/dotted-half) noteheads sometimes missed
- m4 F5 half (top line), m119 G4 dotted half (first bar after the key/time courtesy), m125 G5 dotted half, m161 E5 dotted half are absent in both runs, while other half notes (m8, m121-133 G4, m159, m160) are found. Suspects: `findHollowHeads` (`glyphs.ts`) and the head filter at `symbols.ts:982` / `1113` (heads left of `musicStart` dropped; in baseline m119 may fall inside a too-wide prefix). Not isolated further.

### 8. Rhythm repair destroys correct reads (consequence of 2 and 5)
- `layoutMeasure` rescales in place, so a correctly read eighth becomes 0.75 and durations like 1.25/1.5 appear, confidence 0.7-0.85. Once 3/4 is known most of these should vanish, but the generic repair is quite permissive; consider failing loudly instead of inventing 1.25-beat notes.

### 9. Ties not detected
- m53 B-natural eighth tied to the following quarter B (inside the bar, `~` curve under/over) is not flagged `tiedFromPrevious`; the second B comes out with duration 2.0 (clipped to the barline) rather than a tied 1. `symbols.ts` calls `detectTies` (`ties.ts`). Single sample, low confidence in the diagnosis.

### 10. Rolled chord at m162 split into two onsets
- The final stacked chord (about 8 notes with a wavy roll sign and fermata) is read as two clusters: E5 D5 B4 G4 at beat 0 and F5 D5 G4 C4 at beat 1.5, with duration 1.5 / 2.5. It should be one onset, 3 beats with fermata. Cause is likely the roll sign / offset heads breaking `clusterHeads` (`rhythm.ts`) into two events. Pitches of the second cluster look partly wrong (duplicate G4, D5).

## Things that worked
- Page 4 chord-diagram sheet: no staves found, no notes, one warning.
- Staff/system detection: 29 staves, 29 systems, exactly matching the printed layout; barline detection mostly right.
- Chord names, dynamics, hairpins, accents (>), marcato (^), fermata, rehearsal boxes, title and tempo text produced no spurious notes.
- m3, m158, m121 etc.: letter names and octaves correct once the clef/key is fixed (90% pitch accuracy after the one-constant experiment).
- Slash-only bars: no notes (as intended), warning "5 chord-slash measure(s) were skipped" undercounts (about 100 such bars) because slash detection misses most.
